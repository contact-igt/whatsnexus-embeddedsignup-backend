import { logger } from "../utils/logger.js";
import { syncCatalog } from "../models/AiModelCatalogModel/catalog.service.js";

// Stage C — recurring discovery. Calls the exact same service as the manual
// admin sync. That service:
//   * takes a MySQL advisory lock, so concurrent/duplicate runs are prevented,
//   * uses the platform OpenAI credential only,
//   * makes no generation requests and sends no messages,
//   * never activates a model, configures pricing, or touches tenant selections,
//   * retains the previous catalog on any failure / empty / partial response,
//   * never logs credentials.
let running = false;

export const runAiModelCatalogSyncCron = async () => {
  if (running) {
    logger.debug("[CRON] AI model catalog sync already running — skipping tick.");
    return;
  }
  running = true;
  try {
    const record = await syncCatalog();
    logger.info(
      `[CRON] AI model catalog sync ok: received=${record.models_received} created=${record.models_created} updated=${record.models_updated}`,
    );
  } catch (error) {
    // AI_SYNC_BUSY (another run holds the lock) is expected and benign.
    if (error?.code === "AI_SYNC_BUSY") {
      logger.debug("[CRON] AI model catalog sync skipped — another run in progress.");
    } else {
      logger.error(`[CRON] AI model catalog sync failed (previous catalog retained): ${error.message}`);
    }
  } finally {
    running = false;
  }
};
