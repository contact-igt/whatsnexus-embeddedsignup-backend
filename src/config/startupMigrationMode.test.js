import test from "node:test";
import assert from "node:assert/strict";
import { resolveStartupMigrationMode } from "./startupMigrationMode.js";

test("production line never alter-syncs — NODE_ENV is irrelevant", () => {
  for (const DB_AUTO_MIGRATE of [undefined, "true", "false", "1"]) {
    const r = resolveStartupMigrationMode({ serverLine: "production", DB_AUTO_MIGRATE });
    assert.equal(r.isProduction, true);
    assert.equal(r.autoMigrate, false, `DB_AUTO_MIGRATE=${DB_AUTO_MIGRATE} must not enable prod alter-sync`);
  }
});

test("production alter-sync requires the unmistakable override", () => {
  assert.equal(resolveStartupMigrationMode({ serverLine: "production", ALLOW_PRODUCTION_SCHEMA_ALTER: "true" }).autoMigrate, true);
  assert.equal(resolveStartupMigrationMode({ serverLine: "production", ALLOW_PRODUCTION_SCHEMA_ALTER: "yes" }).autoMigrate, false);
  assert.equal(resolveStartupMigrationMode({ serverLine: "Production", ALLOW_PRODUCTION_SCHEMA_ALTER: "true" }).autoMigrate, true); // case-insensitive line
});

test("stage / development / local auto-migrate by default, opt-out with DB_AUTO_MIGRATE=false", () => {
  for (const line of ["stage", "development", "local", "", undefined]) {
    assert.equal(resolveStartupMigrationMode({ serverLine: line }).autoMigrate, true, `${line} default`);
    assert.equal(resolveStartupMigrationMode({ serverLine: line, DB_AUTO_MIGRATE: "false" }).autoMigrate, false, `${line} opt-out`);
    assert.equal(resolveStartupMigrationMode({ serverLine: line }).isProduction, false);
  }
});

test("reason string is descriptive and secret-free", () => {
  const r = resolveStartupMigrationMode({ serverLine: "production" });
  assert.match(r.reason, /explicit-migrations/);
  assert.doesNotMatch(r.reason, /password|secret|key/i);
});
