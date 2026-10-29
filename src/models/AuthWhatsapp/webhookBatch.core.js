/**
 * Split a Meta payload into the units the established webhook handler accepts.
 * Keeping each message/status separate preserves its existing idempotency gate.
 */
export const getWebhookBatch = (body) => {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      if (change?.field === "messages") {
        for (const message of value.messages || []) {
          events.push({ entry, change: { ...change, value: { ...value, messages: [message], statuses: [] } } });
        }
        for (const status of value.statuses || []) {
          events.push({ entry, change: { ...change, value: { ...value, messages: [], statuses: [status] } } });
        }
        if ((value.messages?.length || value.statuses?.length)) continue;
      }
      events.push({ entry, change });
    }
  }
  return events;
};
