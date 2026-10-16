import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS } from "./aiDefaults.js";

test("DEFAULT_MODELS shape", () => {
  assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), ["input", "output", "vision"]);
  for (const v of Object.values(DEFAULT_MODELS)) assert.equal(typeof v, "string");
});

// The grandfather migration re-declares its model list inline (a migration must
// be frozen + self-contained). Assert every default is still covered there so
// the two never silently diverge.
test("every DEFAULT_MODELS value has a grandfather profile in migrations/20260910", () => {
  const migPath = fileURLToPath(new URL("../../migrations/20260910_ai_model_catalog.js", import.meta.url));
  const src = readFileSync(migPath, "utf8");
  for (const model of Object.values(DEFAULT_MODELS)) {
    assert.match(src, new RegExp(`["']${model.replace(/[.]/g, "\\.")}["']\\s*:`), `${model} missing from GRANDFATHER_PROFILES`);
  }
});
