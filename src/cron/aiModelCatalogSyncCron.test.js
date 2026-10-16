/**
 * Multi-instance / re-entrancy behaviour of the daily catalog sync cron.
 * The DB advisory lock is exercised separately in the catalog integration test;
 * here we prove the cron wrapper handles the outcomes correctly.
 * Run: node --test src/cron/aiModelCatalogSyncCron.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAiModelCatalogSyncCron } from "./aiModelCatalogSyncCron.js";

test("re-entrancy guard: a second concurrent tick on the same instance is skipped", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowSync = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    return { models_received: 1, models_created: 0, models_updated: 1 };
  };
  const [a, b] = await Promise.all([
    runAiModelCatalogSyncCron({ sync: slowSync }),
    runAiModelCatalogSyncCron({ sync: slowSync }),
  ]);
  assert.equal(maxInFlight, 1, "sync never runs twice at once on one instance");
  const outcomes = [a, b].map(o => (o.ok ? "ok" : o.skipped));
  assert.ok(outcomes.includes("ok") && outcomes.includes("reentrant"));
});

test("another instance holds the lock (AI_SYNC_BUSY) → clean skip, no throw", async () => {
  const busy = async () => { const e = new Error("Catalog refresh is already running."); e.code = "AI_SYNC_BUSY"; throw e; };
  const res = await runAiModelCatalogSyncCron({ sync: busy });
  assert.deepEqual(res, { skipped: "locked" });
});

test("provider failure → recorded, not thrown; catalog untouched by the wrapper", async () => {
  const fail = async () => { const e = new Error("OpenAI request failed or timed out."); e.code = "OPENAI_REQUEST_FAILED"; throw e; };
  const res = await runAiModelCatalogSyncCron({ sync: fail });
  assert.ok(res.error);
});

test("guard resets after each run", async () => {
  const ok = async () => ({ models_received: 2, models_created: 1, models_updated: 1 });
  assert.ok((await runAiModelCatalogSyncCron({ sync: ok })).ok);
  assert.ok((await runAiModelCatalogSyncCron({ sync: ok })).ok);
});
