const ANTIGRAVITY_PROVIDER_ID = "antigravity";

export type AntigravityQuotaFamily = "gemini" | "claude" | "other";

function normalizeModelId(model: string | null | undefined): string {
  return String(model || "")
    .trim()
    .toLowerCase();
}

/**
 * Classify Antigravity models by the quota bucket Google Cloud Code/Antigravity
 * appears to enforce. This is intentionally conservative:
 * - gemini-* / google/gemini-* variants share the Gemini family quota.
 * - claude-* and legacy cloud-* aliases are treated as the Claude/Cloud family.
 * - unknown models remain exact-model scoped for compatibility.
 */
export function getAntigravityQuotaFamily(
  model: string | null | undefined
): AntigravityQuotaFamily {
  // Antigravity models (e.g. claude-sonnet-4-6 vs claude-opus-4-6-thinking) have distinct
  // rate limits and quotas. Enforcing a shared "claude" family lock causes a transient Opus 429
  // to freeze Sonnet 4-6 for 3+ hours. By returning "other", each model is isolated to exact-model scope.
  return "other";
}

export function getQuotaScopedModelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!model) return null;
  if (provider !== "antigravity" && provider !== "agy") return model;
  const family = getAntigravityQuotaFamily(model);
  return family === "other" ? model : `family:${family}`;
}

export function getQuotaScopeLabelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string {
  if (provider !== "antigravity" && provider !== "agy") return "model";
  return getAntigravityQuotaFamily(model) === "other" ? "model" : "family";
}
