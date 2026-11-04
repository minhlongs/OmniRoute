/**
 * localDb.ts — compatibility re-export layer.
 *
 * 50bc8ab8aa (#11795 Phase 5) deleted the original 120-entry barrel on the claim
 * that every consumer had migrated, but 19 files still import from here — the
 * route graph then failed to evaluate with `Cannot find module '@/lib/localDb'`
 * and the server could not boot.
 *
 * This file re-exports ONLY the symbols those remaining consumers import, each
 * from the module that defines it today. It is deliberately NOT the old list: the
 * old one referenced ~90 exports that no longer exist, which is how it rotted.
 *
 * To retire it: migrate the remaining `@/lib/localDb` importers to their domain
 * modules (`src/lib/db/*`), then delete this file. Do not add exports here that
 * current importers do not use — that is what turned the previous barrel into a
 * stale mirror of a moving layer.
 */

export { checkKeyModelAccess, getKeyGroupsForApiKey } from "./db/apiKeyGroups.ts";

export { getApiKeyById } from "./db/apiKeys.ts";

export {
  countBatchItemCheckpoints,
  ensureBatchItemCheckpoints,
  getBatch,
  getPendingBatches,
  getTerminalBatches,
  listBatchItemCheckpoints,
  markBatchItemError,
  markBatchItemProcessing,
  markBatchItemResult,
  updateBatch,
} from "./db/batches.ts";

export { createFile, deleteFile, getFileContent, listFiles } from "./db/files.ts";

export { listOneproxyProxies } from "./db/oneproxy.ts";

export { listProxies } from "./db/proxies.ts";

export { resolveProxyForScopeFromRegistry } from "./db/proxies/rotation.ts";

export { getCachedProviderConnectionById } from "./db/readCache.ts";

export { getSettings } from "./db/settings.ts";

export {
  getTokenLimitsForRequest,
  getWindowUsage,
  incrementWindowTokens,
  logTokenLimitReset,
  resetWindowIfElapsed,
} from "./db/tokenLimits.ts";

export { getUpstreamProxyConfig } from "./db/upstreamProxy.ts";
