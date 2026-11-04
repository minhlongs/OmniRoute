// src/lib/usage/callLogArtifactWorker.ts
import { parentPort } from "node:worker_threads";

// src/lib/usage/callLogArtifacts.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/lib/dataPaths.ts
import path from "path";
import os from "os";
import fs from "fs";
var APP_NAME = "omniroute";
function fallbackHomeDir() {
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (typeof envHome === "string" && envHome.trim().length > 0) {
    return path.resolve(envHome);
  }
  return os.tmpdir();
}
function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return fallbackHomeDir();
  }
}
function normalizeConfiguredPath(dir) {
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}
function getLegacyDotDataDir() {
  return path.join(safeHomeDir(), `.${APP_NAME}`);
}
function getDefaultDataDir() {
  const homeDir = safeHomeDir();
  const legacyDir = getLegacyDotDataDir();
  if (fs.existsSync(legacyDir)) {
    try {
      if (fs.statSync(legacyDir).isDirectory()) {
        return legacyDir;
      }
    } catch {}
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }
  const xdgConfigHome = normalizeConfiguredPath(process.env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, APP_NAME);
  }
  return legacyDir;
}
function resolveDataDir({ isCloud: isCloud2 = false } = {}) {
  if (isCloud2) return "/tmp";
  const configured = normalizeConfiguredPath(process.env.DATA_DIR);
  if (configured) return configured;
  return getDefaultDataDir();
}

// src/lib/logEnv.ts
var _DEFAULT_APP_LOG_MAX_SIZE = 50 * 1024 * 1024;
var DEFAULT_CALL_LOG_PIPELINE_MAX_SIZE_KB = 512;
function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function parseBoolean(value, fallback) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
function getCallLogPipelineMaxSizeBytes() {
  return (
    parsePositiveInt(
      process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB,
      DEFAULT_CALL_LOG_PIPELINE_MAX_SIZE_KB
    ) * 1024
  );
}
function isChatDebugFileEnabled() {
  if (parseBoolean(process.env.CHAT_DEBUG_FILE, false)) return true;
  return process.env.APP_LOG_LEVEL?.trim().toLowerCase() === "debug";
}

// src/lib/usage/callLogArtifacts.ts
var isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;
var isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" || process.env.OMNIROUTE_BUILDING === "1";
var DATA_DIR = resolveDataDir({ isCloud });
var CALL_LOGS_DIR = isCloud ? null : path2.join(DATA_DIR, "call_logs");
var MAX_CALL_LOG_ARTIFACT_BYTES = 512 * 1024;
var SIZE_LIMIT_EXCEEDED_REASON = "call_log_artifact_size_limit_exceeded";
var OMITTED_FOR_SIZE_LIMIT = "[omitted: call log artifact size limit exceeded]";
var STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT =
  "[stream chunks omitted: call log artifact size limit exceeded]";
var MAX_PRESERVED_ERROR_BYTES = 4 * 1024;
var ERROR_TRUNCATED_FOR_SIZE_LIMIT = "[truncated: call log artifact size limit exceeded]";
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 192) === 128) end--;
  return buffer.subarray(0, end).toString("utf8");
}
function preserveErrorForSizeLimit(error) {
  if (error === null || error === void 0) return null;
  let serialized;
  try {
    serialized = typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    serialized = String(error);
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PRESERVED_ERROR_BYTES) return error;
  return `${truncateUtf8(serialized, MAX_PRESERVED_ERROR_BYTES)} ${ERROR_TRUNCATED_FOR_SIZE_LIMIT}`;
}
function buildArtifactRelativePath(timestamp, id) {
  const parsed = new Date(timestamp);
  const safeTimestamp = (
    Number.isNaN(parsed.getTime()) ? /* @__PURE__ */ new Date().toISOString() : parsed.toISOString()
  ).replace(/[:]/g, "-");
  const dateFolder = safeTimestamp.slice(0, 10);
  return path2.posix.join(dateFolder, `${safeTimestamp}_${id}.json`);
}
function computeArtifactChecksum(serialized) {
  const bytes = Buffer.from(serialized);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function truncateArtifactForStorage(artifact) {
  const pipeline = artifact.pipeline;
  if (!pipeline?.streamChunks) return artifact;
  return {
    ...artifact,
    pipeline: {
      ...pipeline,
      streamChunks: {
        provider: pipeline.streamChunks.provider?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : void 0,
        openai: pipeline.streamChunks.openai?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : void 0,
        client: pipeline.streamChunks.client?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : void 0,
      },
    },
  };
}
function omitOversizedPipeline(artifact) {
  if (!artifact.pipeline) return artifact;
  return {
    ...artifact,
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}
function getArtifactMaxBytes(artifact) {
  return artifact.pipeline ? getCallLogPipelineMaxSizeBytes() : MAX_CALL_LOG_ARTIFACT_BYTES;
}
function buildMinimalArtifactForSizeLimit(artifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    summary: artifact.summary,
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: OMITTED_FOR_SIZE_LIMIT,
    // Never drop the error: it is the only field that says WHY the request
    // failed (e.g. "Fetch timeout after 110000ms on https://..."). Diagnosing
    // provider outages from a log row that shows only an omission marker is
    // impossible; the error string is tiny next to the request/response bodies.
    error: preserveErrorForSizeLimit(artifact.error),
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}
function serializeFinalSizeLimitFallback(artifact, maxBytes) {
  const withSummary = JSON.stringify(buildMinimalArtifactForSizeLimit(artifact));
  if (Buffer.byteLength(withSummary) <= maxBytes) {
    return withSummary;
  }
  const errorOnly = JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    _omniroute_truncated: true,
    reason: SIZE_LIMIT_EXCEEDED_REASON,
    error: preserveErrorForSizeLimit(artifact.error),
  });
  if (Buffer.byteLength(errorOnly) <= maxBytes) {
    return errorOnly;
  }
  return JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    _omniroute_truncated: true,
    reason: SIZE_LIMIT_EXCEEDED_REASON,
    error: preserveErrorForSizeLimit(artifact.error),
  });
}
function serializeArtifactForStorage(artifact) {
  if (isChatDebugFileEnabled()) {
    return JSON.stringify(artifact, null, 2);
  }
  const maxBytes = getArtifactMaxBytes(artifact);
  const serialized = JSON.stringify(artifact);
  if (Buffer.byteLength(serialized) <= maxBytes) {
    return serialized;
  }
  const truncated = JSON.stringify(truncateArtifactForStorage(artifact));
  if (Buffer.byteLength(truncated) <= maxBytes) {
    return truncated;
  }
  const withoutPipeline = JSON.stringify(omitOversizedPipeline(artifact));
  if (Buffer.byteLength(withoutPipeline) <= maxBytes) {
    return withoutPipeline;
  }
  const minimal = JSON.stringify({
    ...omitOversizedPipeline(artifact),
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: OMITTED_FOR_SIZE_LIMIT,
    error: preserveErrorForSizeLimit(artifact.error),
  });
  if (Buffer.byteLength(minimal) <= maxBytes) {
    return minimal;
  }
  return serializeFinalSizeLimitFallback(artifact, maxBytes);
}
function writeCallArtifact(
  artifact,
  relativePath = buildArtifactRelativePath(artifact.summary.timestamp, artifact.summary.id)
) {
  if (!CALL_LOGS_DIR || isBuildPhase) return null;
  const absPath = path2.join(CALL_LOGS_DIR, relativePath);
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const serialized = serializeArtifactForStorage(artifact);
    const sizeBytes = Buffer.byteLength(serialized);
    const fileChecksum = computeArtifactChecksum(serialized);
    fs2.mkdirSync(path2.dirname(absPath), { recursive: true });
    fs2.writeFileSync(tmpPath, serialized);
    fs2.renameSync(tmpPath, absPath);
    return {
      relPath: relativePath,
      sizeBytes,
      sha256: fileChecksum,
    };
  } catch (error) {
    try {
      fs2.rmSync(tmpPath, { force: true });
    } catch {}
    console.error("[callLogs] Failed to write request artifact:", error.message);
    return null;
  }
}

// src/lib/usage/callLogArtifactWorker.ts
function applyWriteEnvironment(environment) {
  const values = {
    CALL_LOG_PIPELINE_MAX_SIZE_KB: environment.pipelineMaxSizeKb,
    CHAT_DEBUG_FILE: environment.chatDebugFile,
    APP_LOG_LEVEL: environment.appLogLevel,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === void 0) delete process.env[name];
    else process.env[name] = value;
  }
}
parentPort?.on("message", (request) => {
  const originalConsoleError = console.error;
  let result = null;
  try {
    applyWriteEnvironment(request.environment);
    console.error = () => {};
    result = writeCallArtifact(request.artifact);
  } catch {
    result = null;
  } finally {
    console.error = originalConsoleError;
  }
  try {
    parentPort?.postMessage({ id: request.id, result });
  } catch {
    parentPort?.postMessage({ id: request.id, result: null });
  }
});
