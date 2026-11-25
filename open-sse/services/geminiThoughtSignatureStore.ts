import { getDbInstance } from "../../src/lib/db/core.ts";

const MAX_SIGNATURES = 10_000;
const MAX_PERSISTED_SIGNATURES = 20_000;
const MEMORY_TTL_MS = 1000 * 60 * 60 * 24;
const PRUNE_INTERVAL_MS = 60_000;
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const NAMESPACE = "gemini_thought_signatures";

export type SignatureCacheMode = "enabled" | "bypass" | "bypass-strict";

type Entry = {
  signature: string;
  expiresAt: number;
};

type PersistedEntry = Entry & {
  createdAt: number;
};

const signatures = new Map<string, Entry>();
let signatureCacheMode: SignatureCacheMode = "enabled";
let persistedPruneCounter = 0;
let lastPruneAt = Number.NEGATIVE_INFINITY;
const MAX_LOGGED_ERRORS = 50;
const loggedPersistenceErrors = new Set<string>();

function warnPersistenceError(operation: string, error: unknown) {
  if (process.env.NODE_ENV === "test") return;
  if (loggedPersistenceErrors.has(operation)) return;
  if (loggedPersistenceErrors.size >= MAX_LOGGED_ERRORS) {
    const first = loggedPersistenceErrors.values().next().value;
    if (first !== undefined) loggedPersistenceErrors.delete(first);
  }
  loggedPersistenceErrors.add(operation);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[signature-cache] persisted ${operation} failed: ${message}`);
}

export function buildGeminiThoughtSignatureKey(namespace: unknown, toolCallId: unknown): unknown {
  if (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    typeof toolCallId === "string" &&
    toolCallId.length > 0
  ) {
    return `${namespace}:${toolCallId}`;
  }
  return toolCallId;
}

function pruneExpired(force = false, now = Date.now()) {
  if (!force && signatures.size <= MAX_SIGNATURES && now - lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAt = now;
  for (const [key, value] of signatures.entries()) {
    if (value.expiresAt <= now) {
      signatures.delete(key);
    }
  }

  while (signatures.size > MAX_SIGNATURES) {
    const oldestKey = signatures.keys().next().value;
    if (!oldestKey) break;
    signatures.delete(oldestKey);
  }
}

function serializePersistedEntry(entry: PersistedEntry): string {
  return JSON.stringify(entry);
}

function parsePersistedEntry(value: string, now = Date.now()) {
  try {
    const parsed = JSON.parse(value) as Partial<PersistedEntry>;
    if (typeof parsed.signature !== "string" || parsed.signature.length === 0) return null;
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : now;
    const expiresAt =
      typeof parsed.expiresAt === "number" ? parsed.expiresAt : now + PERSISTED_TTL_MS;
    if (expiresAt <= now) return null;
    return {
      entry: { signature: parsed.signature, createdAt, expiresAt },
      shouldRewrite: createdAt !== parsed.createdAt || expiresAt !== parsed.expiresAt,
    };
  } catch {
    if (!value) return null;
    return {
      entry: {
        signature: value,
        createdAt: now,
        expiresAt: now + PERSISTED_TTL_MS,
      },
      shouldRewrite: true,
    };
  }
}

function maybePrunePersistedSignatures(db: ReturnType<typeof getDbInstance>) {
  persistedPruneCounter += 1;
  if (persistedPruneCounter % 500 !== 0) return;

  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ key: string; value: string }>;

  const now = Date.now();
  const validRows: Array<{ key: string; createdAt: number }> = [];
  const keysToDelete = new Set<string>();

  for (const row of rows) {
    const parsed = parsePersistedEntry(row.value, now);
    if (!parsed) {
      keysToDelete.add(row.key);
      continue;
    }
    validRows.push({ key: row.key, createdAt: parsed.entry.createdAt });
  }

  if (rows.length <= MAX_PERSISTED_SIGNATURES && keysToDelete.size === 0) return;

  validRows.sort((a, b) => b.createdAt - a.createdAt);
  for (const row of validRows.slice(MAX_PERSISTED_SIGNATURES)) {
    keysToDelete.add(row.key);
  }

  if (keysToDelete.size === 0) return;
  const remove = db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?");
  const tx = db.transaction((keys: string[]) => {
    for (const key of keys) remove.run(NAMESPACE, key);
  });
  tx([...keysToDelete]);
}

export function storeGeminiThoughtSignature(toolCallId: unknown, signature: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  // Re-insert so existing keys move to the MRU tail before bounded eviction runs.
  signatures.delete(toolCallId);
  signatures.set(toolCallId, {
    signature,
    expiresAt: now + MEMORY_TTL_MS,
  });
  pruneExpired(false, now);

  try {
    const db = getDbInstance();
    db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      toolCallId,
      serializePersistedEntry({ signature, createdAt: now, expiresAt: now + PERSISTED_TTL_MS })
    );
    maybePrunePersistedSignatures(db);
  } catch (error) {
    warnPersistenceError("store", error);
  }
}

export function getGeminiThoughtSignature(toolCallId: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  const now = Date.now();
  const entry = signatures.get(toolCallId);
  if (entry) {
    if (entry.expiresAt > now) {
      // Promote active tool_use signatures to MRU so long sessions stay cached.
      signatures.delete(toolCallId);
      signatures.set(toolCallId, {
        signature: entry.signature,
        expiresAt: now + MEMORY_TTL_MS,
      });
      return entry.signature;
    }
    signatures.delete(toolCallId);
  }

  try {
    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NAMESPACE, toolCallId) as { value: string } | undefined;

    if (row?.value) {
      const persisted = parsePersistedEntry(row.value);
      if (!persisted) {
        db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
          NAMESPACE,
          toolCallId
        );
        return null;
      }

      signatures.delete(toolCallId);
      signatures.set(toolCallId, {
        signature: persisted.entry.signature,
        expiresAt: Date.now() + MEMORY_TTL_MS,
      });
      pruneExpired(false, now);

      if (persisted.shouldRewrite) {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
          serializePersistedEntry(persisted.entry),
          NAMESPACE,
          toolCallId
        );
      }

      return persisted.entry.signature;
    }
  } catch (error) {
    warnPersistenceError("read", error);
  }

  return null;
}

export function normalizeSignatureCacheMode(value: unknown): SignatureCacheMode {
  return value === "bypass" || value === "bypass-strict" ? value : "enabled";
}

export function setGeminiThoughtSignatureMode(mode: unknown) {
  signatureCacheMode = normalizeSignatureCacheMode(mode);
}

export function getGeminiThoughtSignatureMode(): SignatureCacheMode {
  return signatureCacheMode;
}

function decodeSignature(signature: string): Buffer | null {
  if (!signature || (signature[0] !== "R" && signature[0] !== "E")) return null;

  const payload = signature.slice(1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return null;
  }

  try {
    const decoded = Buffer.from(payload, "base64");
    if (decoded.length === 0) return null;

    const canonical = decoded.toString("base64").replace(/=+$/g, "");
    if (canonical !== payload.replace(/=+$/g, "")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function readVarint(
  buffer: Buffer,
  startOffset: number
): { nextOffset: number; value: number } | null {
  let offset = startOffset;
  let result = 0;
  let shift = 0;

  while (offset < buffer.length && shift < 35) {
    const byte = buffer[offset];
    result |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value: result };
    }

    shift += 7;
  }

  return null;
}

export function isValidBasicGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  return Boolean(decoded && decoded[0] === 0x12);
}

export function isValidFullGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  if (!decoded || decoded[0] !== 0x12) return false;

  const outerLength = readVarint(decoded, 1);
  if (!outerLength) return false;

  const outerEnd = outerLength.nextOffset + outerLength.value;
  if (outerEnd !== decoded.length) return false;

  const inner = decoded.subarray(outerLength.nextOffset, outerEnd);
  if (inner.length === 0 || inner[0] !== 0x0a) return false;

  const innerLength = readVarint(inner, 1);
  if (!innerLength) return false;

  return innerLength.nextOffset + innerLength.value === inner.length;
}

export function resolveGeminiThoughtSignature(
  toolCallId: unknown,
  clientSignature?: unknown
): string | null {
  const persisted = getGeminiThoughtSignature(toolCallId);
  if (typeof clientSignature !== "string" || clientSignature.length === 0) {
    return persisted;
  }

  if (signatureCacheMode === "enabled") {
    return persisted;
  }

  const isValid =
    signatureCacheMode === "bypass-strict"
      ? isValidFullGeminiThoughtSignature(clientSignature)
      : isValidBasicGeminiThoughtSignature(clientSignature);

  if (isValid) {
    return clientSignature;
  }

  console.warn(
    `[signature-cache] ${signatureCacheMode}: invalid client thought signature, falling back`
  );
  return persisted;
}

export function clearGeminiThoughtSignatures() {
  signatures.clear();
  lastPruneAt = Number.NEGATIVE_INFINITY;
  signatureCacheMode = "enabled";
  try {
    const db = getDbInstance();
    db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
  } catch (error) {
    warnPersistenceError("clear", error);
  }
}

export function clearGeminiThoughtSignatureMemoryForTests() {
  signatures.clear();
  lastPruneAt = Number.NEGATIVE_INFINITY;
}

export function getGeminiThoughtSignatureMemorySizeForTests() {
  pruneExpired(true);
  return signatures.size;
}

export function __getThoughtSignatureStoreLimitsForTest() {
  return {
    maxMemory: MAX_SIGNATURES,
    maxPersisted: MAX_PERSISTED_SIGNATURES,
    memoryTtlMs: MEMORY_TTL_MS,
    pruneIntervalMs: PRUNE_INTERVAL_MS,
  };
}
