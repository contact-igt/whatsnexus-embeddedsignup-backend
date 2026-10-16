import { jest } from "@jest/globals";
import { confirmModelAccess, sanitizeErrorForAdmin } from "../src/utils/ai/modelAccess.js";
import { classifyTestFailure } from "../src/utils/ai/testFailureClassifier.js";

/**
 * confirmModelAccess must only say "this credential cannot access the model" when OpenAI
 * actually answered 401/403/404. A timeout / network error / 429 / 5xx says nothing about
 * access and must surface as the retryable AI_MODEL_ACCESS_UNKNOWN (503).
 *
 * Regression: a slow first connection made models.retrieve time out at 10s; the catch-all
 * reported "[access] This credential cannot access the model." for a perfectly good key.
 */
let n = 0;
// unique key per client → the module's 60s access cache never leaks between tests
const clientWith = (retrieve) => ({ apiKey: `test-key-${++n}`, models: { retrieve } });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const timeoutError = () => Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });

describe("confirmModelAccess — what counts as 'no access'", () => {
  test.each([401, 403, 404])("HTTP %i → AI_MODEL_ACCESS (403)", async (status) => {
    const client = clientWith(jest.fn(async () => { throw httpError(status); }));
    await expect(confirmModelAccess(client, null, "gpt-4.1", true)).rejects.toMatchObject({ code: "AI_MODEL_ACCESS" });
  });

  test("a response for a different model id → AI_MODEL_ACCESS", async () => {
    const client = clientWith(jest.fn(async () => ({ id: "gpt-4o" })));
    await expect(confirmModelAccess(client, null, "gpt-4.1", true)).rejects.toMatchObject({ code: "AI_MODEL_ACCESS" });
  });

  test("success resolves", async () => {
    const client = clientWith(jest.fn(async () => ({ id: "gpt-4.1" })));
    await expect(confirmModelAccess(client, null, "gpt-4.1", true)).resolves.toBeUndefined();
  });
});

describe("confirmModelAccess — transient failures are NOT access failures", () => {
  test.each([
    ["timeout (no HTTP status)", timeoutError()],
    ["network reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["rate limit 429", httpError(429)],
    ["server error 500", httpError(500)],
    ["bad gateway 502", httpError(502)],
    ["service unavailable 503", httpError(503)],
  ])("%s → AI_MODEL_ACCESS_UNKNOWN (503)", async (_label, err) => {
    const client = clientWith(jest.fn(async () => { throw err; }));
    const thrown = await confirmModelAccess(client, null, "gpt-4.1", true).catch((e) => e);
    expect(thrown).toMatchObject({ code: "AI_MODEL_ACCESS_UNKNOWN", statusCode: 503 });
    expect(thrown.message).not.toMatch(/cannot access/i);
  });

  test("a transient failure is not cached as 'accessible', so the next call re-checks", async () => {
    const retrieve = jest.fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ id: "gpt-4.1" });
    const client = clientWith(retrieve);
    await expect(confirmModelAccess(client, null, "gpt-4.1")).rejects.toMatchObject({ code: "AI_MODEL_ACCESS_UNKNOWN" });
    await expect(confirmModelAccess(client, null, "gpt-4.1")).resolves.toBeUndefined();
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  test("the retry-and-succeed path (the admin re-clicks Test) works and caches", async () => {
    const retrieve = jest.fn(async () => ({ id: "gpt-4.1" }));
    const client = clientWith(retrieve);
    await confirmModelAccess(client, null, "gpt-4.1");
    await confirmModelAccess(client, null, "gpt-4.1");
    expect(retrieve).toHaveBeenCalledTimes(1); // second call served from the 60s cache
  });
});

describe("confirmModelAccess — timeouts", () => {
  test("the request-path check stays fast (10s); admin-forced checks may wait longer (25s)", async () => {
    const retrieve = jest.fn(async () => ({ id: "gpt-4.1" }));
    await confirmModelAccess(clientWith(retrieve), null, "gpt-4.1");
    expect(retrieve.mock.calls[0][1]).toMatchObject({ timeout: 10000, maxRetries: 0 });

    const forced = jest.fn(async () => ({ id: "gpt-4.1" }));
    await confirmModelAccess(clientWith(forced), null, "gpt-4.1", true);
    expect(forced.mock.calls[0][1]).toMatchObject({ timeout: 25000, maxRetries: 0 });
  });
});

describe("admin-facing wording and failure classification", () => {
  const unknown = () => confirmModelAccess(clientWith(jest.fn(async () => { throw timeoutError(); })), null, "gpt-4.1", true).catch((e) => e);
  const denied = () => confirmModelAccess(clientWith(jest.fn(async () => { throw httpError(403); })), null, "gpt-4.1", true).catch((e) => e);

  test("a timeout is reported as reachability, not as missing access", async () => {
    const msg = sanitizeErrorForAdmin(await unknown(), "access");
    expect(msg).toMatch(/could not reach openai|timeout\/network/i);
    expect(msg).not.toMatch(/cannot access the model/i);
    expect(msg).not.toMatch(/server error/i); // our own 503 is not an OpenAI server error
  });

  test("a real denial still reads as 'cannot access the model'", async () => {
    expect(sanitizeErrorForAdmin(await denied(), "access")).toMatch(/cannot access the model/i);
  });

  test("classification: unreachable → transient (never marks a model failed); denied → configuration", async () => {
    expect(classifyTestFailure(await unknown(), "access").failureClass).toBe("transient");
    expect(classifyTestFailure(await denied(), "access").failureClass).toBe("configuration");
  });
});
