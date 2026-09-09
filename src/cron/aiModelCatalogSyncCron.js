import { logger } from "../utils/logger.js";
import { syncCatalog } from "../models/AiModelCatalogModel/catalog.service.js";

// Stage C — recurring discovery. Calls the exact same service as the manual
// admin sync. That service:
//   * takes a MySQL advisory lock, so concurrent runs across MULTIPLE backend
//     instances are serialised — only one instance actually syncs, the others
//     get AI_SYNC_BUSY and exit cleanly,
//   * uses the platform OpenAI credential only,
//   * makes no generation requests and sends no messages,
//   * never activates a model, configures pricing, or touches tenant selections,
//   * retains the previous catalog on any failure / empty / partial response,
//   * never logs credentials.
let running = false;

/**
 * @param {object} [opts]
 * @param {() => Promise<any>} [opts.sync] - injectable for tests
 */
export const runAiModelCatalogSyncCron = async ({ sync = syncCatalog } = {}) => {
  // Per-instance re-entrancy guard (the DB lock handles cross-instance).
  if (running) {
    logger.debug("[CRON] AI model catalog sync already running on this instance — skipping tick.");
    return { skipped: "reentrant" };
  }
  running = true;
  try {
    const record = await sync();
    logger.info(
      `[CRON] AI model catalog sync ok: received=${record?.models_received} created=${record?.models_created} updated=${record?.models_updated}`,
    );
    return { ok: true, record };
  } catch (error) {
    // AI_SYNC_BUSY (another instance holds the lock) is expected and benign.
    if (error?.code === "AI_SYNC_BUSY") {
      logger.debug("[CRON] AI model catalog sync skipped — another instance is syncing.");
      return { skipped: "locked" };
    }
    logger.error(`[CRON] AI model catalog sync failed (previous catalog retained): ${error.message}`);
    return { error: error.message };
  } finally {
    running = false;
  }
};
