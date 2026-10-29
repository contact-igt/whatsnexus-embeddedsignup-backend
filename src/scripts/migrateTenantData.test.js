import assert from "node:assert/strict";
import test from "node:test";
import { HEALTHCARE_TABLE_ORDER, destinationInsertId, mapCampaignRecipient, mapContactGroupMember, mapHealthcareAppointment, mapKnowledgeChunk, migratedContactId, migratedGroupId, migratedLeadId, migrateMessageUnderstanding, migrateMessages, parseArgs, validateOptions } from "./migrateTenantData.js";

const env = {
  SOURCE_DATABASE_URL: "mysql://source:secret@old.example/whatsnexus",
  DESTINATION_DATABASE_URL: "mysql://destination:secret@new.example/whatsnexus_embedded",
};

test("migration CLI requires explicit, different tenants and database URLs", () => {
  const options = parseArgs(["--source-tenant", "TT005", "--target-tenant", "TT105", "--dry-run"]);
  assert.doesNotThrow(() => validateOptions(options, env));
  assert.throws(() => validateOptions({ ...options, targetTenant: "TT005" }, env), /must be different/);
  assert.throws(() => validateOptions(options, { ...env, DESTINATION_DATABASE_URL: env.SOURCE_DATABASE_URL }), /URLs must be different/);
});

test("migration contact IDs are stable and tenant-namespaced", () => {
  assert.equal(migratedContactId("TT005", "CNT00001"), migratedContactId("TT005", "CNT00001"));
  assert.notEqual(migratedContactId("TT005", "CNT00001"), migratedContactId("TT001", "CNT00001"));
});

test("migration lead IDs are stable and distinct from contact IDs", () => {
  assert.equal(migratedLeadId("TT005", "LD00001"), migratedLeadId("TT005", "LD00001"));
  assert.notEqual(migratedLeadId("TT005", "LD00001"), migratedContactId("TT005", "LD00001"));
});

test("migration group IDs are stable and distinct from lead IDs", () => {
  assert.equal(migratedGroupId("TT005", "GRP1"), migratedGroupId("TT005", "GRP1"));
  assert.notEqual(migratedGroupId("TT005", "GRP1"), migratedLeadId("TT005", "GRP1"));
});

test("contact-group members map to the migrated group and contact IDs", () => {
  const mapped = mapContactGroupMember("TT013", "TT005", { group_id: "GRP1", contact_id: "CNT1" });
  assert.equal(mapped.tenant_id, "TT005");
  assert.equal(mapped.group_id, migratedGroupId("TT013", "GRP1"));
  assert.equal(mapped.contact_id, migratedContactId("TT013", "CNT1"));
});

test("migration CLI accepts apply only with explicit inputs", () => {
  const options = parseArgs(["--source-tenant", "TT005", "--target-tenant", "TT105", "--apply"]);
  assert.doesNotThrow(() => validateOptions(options, env));
});

test("migration CLI accepts the all-supported batch mode", () => {
  const options = parseArgs(["--source-tenant", "TT013", "--target-tenant", "TT005", "--apply-all-supported"]);
  assert.equal(options.mode, "apply-all-supported");
  assert.doesNotThrow(() => validateOptions(options, env));
});

test("message dry-run blocks messages without a restart-safe wamid", async () => {
  const sourceDb = { query: async () => [{ id: 1, contact_id: "CNT1", wamid: null }] };
  const destinationDb = { query: async () => [] };
  const report = await migrateMessages({ sourceDb, destinationDb, sourceTenant: "TT005", targetTenant: "TT001", apply: false });
  assert.equal(report.ready.length, 0);
  assert.match(report.conflicts[0].reason, /missing wamid/);
});

test("message understanding maps a source message through wamid to the destination message ID", async () => {
  const sourceDb = {
    query: async () => [{ id: 1, contact_id: "CNT1", lead_id: "LD1", message_id: 7, wamid: "wamid.1", source: "classifier", primary_intent: "GENERAL_QUESTION" }],
  };
  let calls = 0;
  const destinationDb = {
    query: async () => {
      calls += 1;
      if (calls === 1) return [{ contact_id: migratedContactId("TT005", "CNT1") }];
      if (calls === 2) return [{ lead_id: migratedLeadId("TT005", "LD1") }];
      if (calls === 3) return [{ id: 99, wamid: "wamid.1" }];
      if (calls === 4) return [];
      return [];
    },
  };
  const report = await migrateMessageUnderstanding({ sourceDb, destinationDb, sourceTenant: "TT005", targetTenant: "TT001", apply: false });
  assert.equal(report.ready.length, 1);
  assert.equal(report.ready[0].mapped_message_id, 99);
  assert.equal(report.conflicts.length, 0);
});

test("healthcare migration preserves dependency order", () => {
  assert.deepEqual(HEALTHCARE_TABLE_ORDER, [
    "specializations", "doctors", "doctor_specializations", "doctor_availability",
    "doctor_availability_days", "appointment_slots", "appointments",
  ]);
});

test("healthcare appointments retain doctor IDs and map migrated contact and lead IDs", () => {
  const mapped = mapHealthcareAppointment("TT005", "TT001", {
    appointment_id: "AP001", doctor_id: "DOC00002", contact_id: "CNT00309", lead_id: "L308", slot_id: null,
  });
  assert.equal(mapped.tenant_id, "TT001");
  assert.equal(mapped.doctor_id, "DOC00002");
  assert.equal(mapped.contact_id, migratedContactId("TT005", "CNT00309"));
  assert.equal(mapped.lead_id, migratedLeadId("TT005", "L308"));
  assert.equal(mapped.slot_id, null);
});

test("campaign recipients retain history but map contact IDs", () => {
  const mapped = mapCampaignRecipient("TT005", {
    campaign_id: "CAMP00018", contact_id: "CNT03823", mobile_number: "916369441531", status: "read",
  });
  assert.equal(mapped.campaign_id, "CAMP00018");
  assert.equal(mapped.contact_id, migratedContactId("TT005", "CNT03823"));
  assert.equal(mapped.status, "read");
});

test("knowledge chunks receive their destination parent source ID", () => {
  const mapped = mapKnowledgeChunk(new Map([[23, 101]]), "TT001", {
    source_id: 23, chunk_text: "Cataract FAQ", embedding: [0.1], is_deleted: false,
  });
  assert.equal(mapped.tenant_id, "TT001");
  assert.equal(mapped.source_id, 101);
  assert.equal(mapped.chunk_text, "Cataract FAQ");
});

test("knowledge source mapping uses Sequelize MySQL's numeric insert result", () => {
  assert.equal(destinationInsertId(101), 101);
});
