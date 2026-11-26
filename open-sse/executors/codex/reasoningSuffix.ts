export const CODEX_EFFORT_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexEffortLevel = (typeof CODEX_EFFORT_ORDER)[number];
export const GPT_5_6_MAX_ALIAS_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const GPT_5_6_ULTRA_ALIAS_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
export const CODEX_ULTRA_ALIAS_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
]);
export const CODEX_MAX_ALIAS_MODELS = new Set([
  ...CODEX_ULTRA_ALIAS_MODELS,
  "gpt-5.6-luna",
  "gpt-6-luna",
]);

export function splitCodexReasoningSuffix(model: unknown): {
  baseModel: string;
  effort: CodexEffortLevel | null;
} {
  const modelId = typeof model === "string" ? model : "";
  const highTierMatch = /^([a-z0-9.-]+?)(?:-(max|ultra)|\((max|ultra)\))$/.exec(modelId);
  if (highTierMatch) {
    const [, baseModel, hyphenEffort, parenthesizedEffort] = highTierMatch;
    const effort = hyphenEffort ?? parenthesizedEffort;
    const supportedModels =
      effort === "ultra" && !parenthesizedEffort
        ? CODEX_ULTRA_ALIAS_MODELS
        : CODEX_MAX_ALIAS_MODELS;
    if (supportedModels.has(baseModel)) {
      return { baseModel, effort: effort as CodexEffortLevel };
    }
  }

  for (const effort of ["none", "low", "medium", "high", "xhigh"] as const) {
    if (modelId.endsWith(`-${effort}`)) {
      return { baseModel: modelId.slice(0, -`-${effort}`.length), effort };
    }
  }
  return { baseModel: modelId, effort: null };
}

export const CODEX_MAX_EFFORT_BY_MODEL: Record<string, CodexEffortLevel> = {
  "gpt-6.2-sol": "ultra",
  "gpt-6.2-astra": "ultra",
  "gpt-6.1-sol": "ultra",
  "gpt-6.1-terra": "ultra",
  "gpt-6-astra": "ultra",
  "gpt-6-sol": "ultra",
  "gpt-6-luna": "max",
  "gpt-5.6-sol": "ultra",
  "gpt-5.6-terra": "ultra",
  "gpt-5.6-luna": "max",
  "gpt-5.3-codex": "xhigh",
  "gpt-5.1-codex-max": "xhigh",
  "gpt-5-mini": "high",
  "gpt-5.1-mini": "high",
  "gpt-4.1-mini": "high",
};

export function isCodexDelegationDependentModel(model: unknown): boolean {
  const { baseModel, effort } = splitCodexReasoningSuffix(model);
  if (
    effort === "ultra" &&
    (GPT_5_6_ULTRA_ALIAS_MODELS.has(baseModel) || CODEX_ULTRA_ALIAS_MODELS.has(baseModel))
  ) {
    return true;
  }
  if (effort === "max" && (baseModel === "gpt-5.6-luna" || baseModel === "gpt-6-luna")) return true;
  return false;
}
