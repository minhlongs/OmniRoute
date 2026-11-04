/**
 * phaseComboSetup — the first extracted phase of handleComboChat (combo.ts).
 *
 * Resolves the per-request combo setup BEFORE dispatch: routing strategy, context-relay
 * config, resilience settings, universal-handoff config, server-side context-cache pinning
 * (which rewrites ctx.body), combo agent middleware (also rewrites ctx.body), the config
 * cascade, the per-target timeout, and the reasoning-token-buffer flag. Behaviour is
 * byte-identical to the inline block it replaces — it just reads/writes via ComboContext.
 *
 * See _tasks/quality/2026-06-19-DESIGN-godfiles-decomposition.md §4.
 */
import { normalizeRoutingStrategy } from "../../../src/shared/constants/routingStrategies.ts";
import {
  resolveContextRelayConfig,
  resolveUniversalHandoffConfig,
  SKIP_UNIVERSAL_HANDOFF_FLAG,
} from "../contextHandoff.ts";
import { getLastSessionModel } from "../../../src/lib/db/contextHandoffs.ts";
import { applyComboAgentMiddleware } from "../comboAgentMiddleware.ts";
import { resolveComboSetupConfig, resolveComboTargetTimeoutMsForCombo } from "../comboConfig.ts";
import { resolveResilienceSettings } from "../../../src/lib/resilience/settings";
import { FETCH_TIMEOUT_MS } from "../../config/constants.ts";
import { deriveComboSessionKey } from "./autoStrategy.ts";
import { loadAdaptationScores, getExcludedProviders } from "./adaptation/store.ts";
import { applyScoreToWeight } from "./adaptation/score.ts";
import type { ComboLike, ComboLogger, ResolvedComboTarget } from "./types.ts";
import type { ComboContext } from "./context.ts";

export interface ComboSetup {
  strategy: ReturnType<typeof normalizeRoutingStrategy>;
  relayConfig: ReturnType<typeof resolveContextRelayConfig> | null;
  resilienceSettings: ReturnType<typeof resolveResilienceSettings>;
  universalHandoffConfig: ReturnType<typeof resolveUniversalHandoffConfig>;
  effectiveSessionId: string | null;
  pinnedModel: string | null;
  clientRequestedStream: boolean;
  config: ReturnType<typeof resolveComboSetupConfig>;
  comboTargetTimeoutMs: number;
  comboTimeoutMs: number;
  reasoningTokenBufferEnabled: boolean;
}

/**
 * Server-side context cache pinning (replaces the <omniModel> tag roundtrip): re-pins the
 * combo to the model used last for this session via session_model_history — no client-side
 * tag injection, no visible output pollution. Rewrites ctx.body when a model is pinned.
 *
 * #3825: when the client sends no session id (most OpenAI-compatible clients), fall back to a
 * stable conversation fingerprint derived from the body so the combo still re-pins across
 * turns. ONLY engaged when context_cache_protection is truthy — when off, behaviour is
 * unchanged (combos rotate as before, no pin read/write, no <omniModel> tag).
 *
 * Extracted from phaseComboSetup to keep that function under the complexity ceiling and to
 * further the combo god-file decomposition.
 */
function resolveContextCachePin(ctx: ComboContext): {
  effectiveSessionId: string | null;
  pinnedModel: string | null;
} {
  const { combo, relayOptions, log } = ctx;
  const effectiveSessionId: string | null = combo.context_cache_protection
    ? (relayOptions?.sessionId ?? deriveComboSessionKey(ctx.body))
    : null;
  let pinnedModel: string | null = null;
  if (
    combo.context_cache_protection &&
    effectiveSessionId &&
    !(ctx.body as Record<string, unknown>)?.[SKIP_UNIVERSAL_HANDOFF_FLAG]
  ) {
    const pinned = getLastSessionModel(effectiveSessionId, combo.name);
    if (pinned) {
      ctx.body = { ...ctx.body, model: pinned };
      pinnedModel = pinned;
      log.info("COMBO", `[#401] Context cache: pinned model=${pinned} (server-side)`);
    }
  }
  return { effectiveSessionId, pinnedModel };
}

export function phaseComboSetup(ctx: ComboContext): ComboSetup {
  const { combo, settings, relayOptions } = ctx;

  const strategy = normalizeRoutingStrategy(combo.strategy || "priority");
  const relayConfig =
    strategy === "context-relay" ? resolveContextRelayConfig(relayOptions?.config || null) : null;

  const resilienceSettings = settings
    ? resolveResilienceSettings(settings)
    : resolveResilienceSettings(null);

  const universalHandoffConfig = resolveUniversalHandoffConfig(
    (combo.universal_handoff || combo.universalHandoff) as
      Record<string, unknown> | null | undefined,
    relayOptions?.universalHandoffConfig as Record<string, unknown> | null | undefined
  );

  // Server-side context cache pinning (rewrites ctx.body when a model is pinned).
  const { effectiveSessionId, pinnedModel } = resolveContextCachePin(ctx);

  // ── Combo Agent Middleware (#399 + #401) ────────────────────────────────
  // Apply system_message override, tool_filter_regex.
  // Context cache pinning is handled above via session_model_history.
  const { body: agentBody } = applyComboAgentMiddleware(
    ctx.body,
    combo,
    "" // provider/model not yet known — resolved per-model in loop
  );
  ctx.body = agentBody;
  const clientRequestedStream = ctx.body?.stream === true;

  // Use config cascade before dispatch so all strategies, pinned context routes,
  // and round-robin targets share the same timeout policy.
  const config = resolveComboSetupConfig(combo, settings);
  const comboTargetTimeoutMs = resolveComboTargetTimeoutMsForCombo(
    config,
    FETCH_TIMEOUT_MS,
    strategy,
    resilienceSettings.comboCooldownWait
  );
  const comboTimeoutMs = config.comboTimeoutMs || 0;
  const reasoningTokenBufferEnabled = config.reasoningTokenBufferEnabled !== false;

  return {
    strategy,
    relayConfig,
    resilienceSettings,
    universalHandoffConfig,
    effectiveSessionId,
    pinnedModel,
    clientRequestedStream,
    config,
    comboTargetTimeoutMs,
    comboTimeoutMs,
    reasoningTokenBufferEnabled,
  };
}

/**
 * Auto-Combo Adaptation Engine — apply hook (OMNIROUTE_COMBO_ADAPTATION=1).
 *
 * Folds learned per-(combo, model) scores into the pre-dispatch target order:
 *  - priority: stable-sort quarantined (excluded) providers to the end, then the
 *    remaining targets by descending learned score. ES2019 sort is stable, so the
 *    operator's list order breaks score ties, and excluded providers stay
 *    eligible as fallbacks rather than being dropped from the pool.
 *  - weighted: handled BEFORE target resolution via
 *    adaptComboWeightsForWeightedStrategy() (weights must be scaled on the combo
 *    models before selectWeightedTarget() runs — scaling the resolved targets
 *    afterwards has no effect on selection).
 *  - every other strategy, the flag-off path, and any load failure return the
 *    input untouched (fail-open).
 */
export async function applyComboAdaptationOrdering(
  strategy: string,
  orderedTargets: ResolvedComboTarget[],
  combo: ComboLike,
  log: ComboLogger
): Promise<ResolvedComboTarget[]> {
  if (process.env.OMNIROUTE_COMBO_ADAPTATION !== "1") return orderedTargets;
  if (strategy !== "priority") return orderedTargets;
  if (orderedTargets.length === 0) return orderedTargets;
  try {
    const comboId = combo.id || combo.name;
    const [scores, excludedProviders] = await Promise.all([
      loadAdaptationScores(comboId),
      getExcludedProviders(comboId),
    ]);

    const adapted = [...orderedTargets];
    adapted.sort((a, b) => {
      const aExcluded = excludedProviders.has(a.modelStr);
      const bExcluded = excludedProviders.has(b.modelStr);
      if (aExcluded !== bExcluded) return aExcluded ? 1 : -1;
      return (
        (scores.get(b.modelStr)?.learnedScore ?? 0.5) -
        (scores.get(a.modelStr)?.learnedScore ?? 0.5)
      );
    });
    if (adapted.some((target, index) => target !== orderedTargets[index])) {
      log.info(
        "COMBO",
        `Adaptation ordering (priority): ${adapted[0]?.modelStr} first, excluded moved last`
      );
    }
    return adapted;
  } catch (err) {
    log.warn("COMBO", "Auto-combo adaptation apply failed — ordering untouched", { err });
  }
  return orderedTargets;
}

/**
 * Auto-Combo Adaptation Engine — weighted pre-resolution hook.
 *
 * The weighted strategy picks its primary target inside resolveWeightedTargets()
 * from the combo's model weights, which runs during target resolution — so the
 * learned score must be folded into `combo.models[].weight` BEFORE the pipeline
 * starts. Returns a shallow clone of the combo with scaled weights (never mutates
 * the caller's object). Fail-open: any error returns the combo untouched.
 */
export async function adaptComboWeightsForWeightedStrategy(
  combo: ComboLike,
  log: ComboLogger
): Promise<ComboLike> {
  if (process.env.OMNIROUTE_COMBO_ADAPTATION !== "1") return combo;
  const models = combo.models;
  if (!Array.isArray(models) || models.length === 0) return combo;
  try {
    const scores = await loadAdaptationScores(combo.id || combo.name);
    const scaledModels = models.map((entry) => {
      if (entry === null || typeof entry !== "object") return entry;
      const modelEntry = entry as Record<string, unknown>;
      const weight = modelEntry.weight;
      if (typeof weight !== "number" || !Number.isFinite(weight)) return entry;
      const modelStr = typeof modelEntry.model === "string" ? modelEntry.model : "";
      const adjusted = applyScoreToWeight(weight, scores.get(modelStr)?.learnedScore ?? 0.5);
      if (adjusted === weight) return entry;
      return { ...modelEntry, weight: adjusted };
    });
    if (scaledModels.every((entry, index) => entry === models[index])) return combo;
    log.info(
      "COMBO",
      `Adaptation weights (weighted): ${combo.name} — model weights scaled by learned score`
    );
    return { ...combo, models: scaledModels };
  } catch (err) {
    log.warn("COMBO", "Auto-combo adaptation weighted hook failed — weights untouched", { err });
  }
  return combo;
}
