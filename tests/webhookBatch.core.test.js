import { getWebhookBatch } from "../src/models/AuthWhatsapp/webhookBatch.core.js";

test("expands every entry, change, inbound message and status without dropping metadata", () => {
  const body = { entry: [
    { id: "waba-a", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-a" }, messages: [{ id: "m1" }, { id: "m2" }], statuses: [{ id: "s1" }] } }] },
    { id: "waba-b", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-b" }, statuses: [{ id: "s2" }] } }, { field: "message_template_status_update", value: { event: "APPROVED" } }] },
  ] };

  const batch = getWebhookBatch(body);
  expect(batch).toHaveLength(5);
  expect(batch.map(({ entry, change }) => [entry.id, change.value.metadata?.phone_number_id, change.value.messages?.[0]?.id, change.value.statuses?.[0]?.id, change.field])).toEqual([
    ["waba-a", "phone-a", "m1", undefined, "messages"],
    ["waba-a", "phone-a", "m2", undefined, "messages"],
    ["waba-a", "phone-a", undefined, "s1", "messages"],
    ["waba-b", "phone-b", undefined, "s2", "messages"],
    ["waba-b", undefined, undefined, undefined, "message_template_status_update"],
  ]);
});
