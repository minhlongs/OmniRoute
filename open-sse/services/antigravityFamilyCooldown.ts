/**
 * Persist Antigravity/agy quota cooldowns per model family (gemini vs claude)
 * on the connection row, without cooling the whole account.
 */
import { lockModel, lockExactModel } from "./accountFallback.ts";
import {
  getAntigravityQuotaFamily,
  isAntigravityQuotaProvider,
} from "./antigravityQuotaFamily.ts";

type JsonRecord = Record<string, unknown>;

const FAMILY_PSD_KEY = "antigravityFamilyRateLimitedUntil";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function parseUntilMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

function dummyModelForFamily(family: "gemini" | "claude"): string {
  return family === "gemini" ? "gemini-family-lock" : "claude-family-lock";
}

function lockAntigravityFamilyModel(
  connectionId: string,
  model: string,
  reason: string,
  cooldownMs: number
): void {
  // Cap Antigravity family lock to at most 180s (3 minutes) to avoid paralysis
  const cappedCooldownMs = Math.min(cooldownMs, 180_000);
  lockModel("agy", connectionId, model, reason, cappedCooldownMs);
  lockModel("antigravity", connectionId, model, reason, cappedCooldownMs);
}

export async function persistAntigravityFamilyCooldown(params: {
  connectionId: string;
  model: string;
  rateLimitedUntil: string;
}): Promise<JsonRecord | null> {
  if (!params.model.trim()) return null;
  const family = getAntigravityQuotaFamily(params.model);
  if (family === "other") return null;

  const { getProviderConnectionById, updateProviderConnection } = await import(
    "@/lib/db/providers"
  );
  const conn = (await getProviderConnectionById(params.connectionId)) as
    | { provider?: string; providerSpecificData?: JsonRecord | null }
    | null;
  if (!conn || !isAntigravityQuotaProvider(conn.provider ?? null)) return null;

  const psd = asRecord(conn.providerSpecificData);
  const untils = asRecord(psd[FAMILY_PSD_KEY]);
  const existingMs = parseUntilMs(untils[family]);
  const nextMs = parseUntilMs(params.rateLimitedUntil);
  if (!Number.isFinite(nextMs)) return psd;
  // Cap Antigravity persisted lock to at most 180s from now
  const cappedNextMs = Math.min(nextMs, Date.now() + 180_000);
  const effectiveUntil = new Date(cappedNextMs).toISOString();
  if (Number.isFinite(existingMs) && existingMs > Date.now() && existingMs >= cappedNextMs) {
    return psd;
  }

  const nextPsd: JsonRecord = {
    ...psd,
    [FAMILY_PSD_KEY]: { ...untils, [family]: effectiveUntil },
  };
  await updateProviderConnection(params.connectionId, { providerSpecificData: nextPsd });
  return nextPsd;
}

/** Fire-and-forget family PSD write. RPM/burst 429s must pass reason !== quota_exhausted. */
export function persistAntigravityFamilyCooldownIfQuota(params: {
  provider?: string | null;
  connectionId: string;
  model?: string | null;
  cooldownMs: number;
  reason?: string | null;
}): void {
  if (!isAntigravityQuotaProvider(params.provider)) return;
  if (!params.model?.trim() || params.cooldownMs <= 0) return;
  if (params.reason != null && params.reason !== "quota_exhausted") return;
  void persistAntigravityFamilyCooldown({
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: new Date(Date.now() + params.cooldownMs).toISOString(),
  }).catch(() => {});
}

export async function persistAntigravityPreflightFamilyLock(params: {
  provider: string;
  connectionId: string;
  model: string;
  unavailableUntil: string;
}): Promise<void> {
  const cooldownMs = Math.max(0, Date.parse(params.unavailableUntil) - Date.now());
  if (params.model.toLowerCase().includes("opus")) {
    lockExactModel("agy", params.connectionId, params.model, "quota_exhausted", cooldownMs);
    lockExactModel("antigravity", params.connectionId, params.model, "quota_exhausted", cooldownMs);
    return;
  }
  lockAntigravityFamilyModel(params.connectionId, params.model, "quota_exhausted", cooldownMs);
  await persistAntigravityFamilyCooldown({
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: params.unavailableUntil,
  });
}

export function rehydrateAntigravityFamilyLocks(
  provider: string,
  connectionId: string,
  providerSpecificData: JsonRecord | null | undefined
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  const untils = asRecord(asRecord(providerSpecificData)[FAMILY_PSD_KEY]);
  const now = Date.now();
  for (const family of ["gemini", "claude"] as const) {
    const untilMs = parseUntilMs(untils[family]);
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    const model = dummyModelForFamily(family);
    const remainingMs = Math.min(untilMs - now, 180_000);
    lockAntigravityFamilyModel(connectionId, model, "quota_exhausted", remainingMs);
  }
}

export function rehydrateAntigravityFamilyLocksForConnections(
  provider: string,
  connections: Array<{ id: string; providerSpecificData?: unknown }>
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  for (const conn of connections) {
    rehydrateAntigravityFamilyLocks(
      provider,
      conn.id,
      conn.providerSpecificData as JsonRecord | null | undefined
    );
  }
}

/** Family lock for executor quota exhaustion. Returns false when model is absent. */
export function markAntigravityModelQuotaExhausted(
  connectionId: string,
  retryAfterMs: number,
  model?: string | null
): boolean {
  if (!model) return false;
  const isClaude = /claude|opus|sonnet/i.test(model);
  const cappedCooldown = Math.min(Math.max(retryAfterMs, 10_000), 180_000);

  if (isClaude) {
    // Lock Claude family so all Claude 5.5 legs skip this connection without latency
    lockAntigravityFamilyModel(connectionId, "claude-family-lock", "quota_exhausted", cappedCooldown);
    // Also lock exact model and aliases
    lockExactModel("agy", connectionId, model, "quota_exhausted", cappedCooldown);
    lockExactModel("antigravity", connectionId, model, "quota_exhausted", cappedCooldown);
    lockExactModel("agy", connectionId, "claude-opus-5-5-high", "quota_exhausted", cappedCooldown);
    lockExactModel("antigravity", connectionId, "claude-opus-5-5-high", "quota_exhausted", cappedCooldown);
    lockExactModel("agy", connectionId, "claude-sonnet-5-5-high", "quota_exhausted", cappedCooldown);
    lockExactModel("antigravity", connectionId, "claude-sonnet-5-5-high", "quota_exhausted", cappedCooldown);

    persistAntigravityFamilyCooldownIfQuota({
      provider: "agy",
      connectionId,
      model: "claude-family-lock",
      cooldownMs: cappedCooldown,
      reason: "quota_exhausted",
    });
    return true;
  }

  // Non-Claude (Gemini):
  lockAntigravityFamilyModel(connectionId, model, "quota_exhausted", cappedCooldown);
  persistAntigravityFamilyCooldownIfQuota({
    provider: "agy",
    connectionId,
    model,
    cooldownMs: cappedCooldown,
    reason: "quota_exhausted",
  });
  return true;
}
