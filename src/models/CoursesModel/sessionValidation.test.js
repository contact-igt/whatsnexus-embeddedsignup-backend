import test from "node:test";
import assert from "node:assert/strict";
import { validateSession } from "./sessionValidation.js";

test("session validation accepts scheduling data and rejects invalid dates, fields, and links", () => {
  const valid = { title: "Training", host: "Trainer", topic: "Technical", scheduledMs: Date.now() + 3600000, durationMinutes: 60, meetingLink: "https://meet.example.com/training" };
  assert.equal(validateSession(valid), null);
  for (const change of [{ title: " " }, { host: null }, { topic: "Unknown" }, { scheduledMs: Date.now() - 1 },
    { scheduledMs: Infinity }, { durationMinutes: 0 }, { durationMinutes: 1.5 }, { durationMinutes: 1441 },
    { meetingLink: "javascript:alert(1)" }, { meetingLink: "invalid" }]) {
    assert.ok(validateSession({ ...valid, ...change }));
  }
  assert.ok(validateSession(null));
});
