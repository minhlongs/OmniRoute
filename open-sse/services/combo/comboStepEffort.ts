/**
 * Out-of-band marker + copy-on-write applier for combo-step `reasoningEffort` overrides.
 *
 * Stores WeakSets on `globalThis` (same cross-bundle singleton pattern as thinkingBudget.ts)
 * so Next.js standalone chunks share one marker registry, and marks both the cloned
 * `attemptBody` and any cloned nested config (`output_config` / `reasoning` / `thinking`) so:
 *  - zero enumerable or Symbol keys are added to payloads (100% invisible to
 *    JSON.stringify, Object.keys, Reflect.ownKeys, deepFreeze, and structuredClone),
 *  - downstream shallow copies (`chatCore`, `applyCompression`, `expandComboSystemPromptIfPresent`,
 *    and cross-format `translateRequest`) preserve the override signal, and
 *  - `deps.body` and its nested objects (`deps.body.thinking`, `deps.body.output_config`,
 *    `deps.body.reasoning`) are NEVER mutated or marked.
 */
import { getModelSpec, isAdaptiveThinkingOnly } from "../../../src/shared/constants/modelSpecs.ts";

type ComboEffortMarkerStore = {
  bodies: WeakSet<object>;
  nestedConfigs: WeakSet<object>;
};

const GLOBAL_MARKER_KEY = "__omniroute_comboStepEffortMarkers__";
const globalStore = globalThis as unknown as Record<string, ComboEffortMarkerStore | undefined>;
if (!globalStore[GLOBAL_MARKER_KEY]) {
  globalStore[GLOBAL_MARKER_KEY] = {
    bodies: new WeakSet<object>(),
    nestedConfigs: new WeakSet<object>(),
  };
}
const { bodies: comboStepEffortBodies, nestedConfigs: comboStepEffortNestedConfigs } =
  globalStore[GLOBAL_MARKER_KEY]!;

export const COMBO_STEP_EFFORT_PATTERN = /^(none|minimal|low|medium|high|xhigh|max)$/;

export function markComboStepEffort(attemptBody: unknown, nestedConfig?: unknown): void {
  if (attemptBody && typeof attemptBody === "object") {
    comboStepEffortBodies.add(attemptBody as object);
  }
  if (nestedConfig && typeof nestedConfig === "object") {
    comboStepEffortNestedConfigs.add(nestedConfig as object);
  }
}

export function propagateComboStepEffort(sourceBody: unknown, clonedBody: unknown): void {
  if (hasComboStepEffort(sourceBody) && clonedBody && typeof clonedBody === "object") {
    comboStepEffortBodies.add(clonedBody as object);
  }
}

export function hasComboStepEffort(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if (comboStepEffortBodies.has(body as object)) return true;
  const record = body as Record<string, unknown>;
  for (const key of ["output_config", "reasoning", "thinking"] as const) {
    const child = record[key];
    if (child && typeof child === "object" && comboStepEffortNestedConfigs.has(child as object)) {
      return true;
    }
  }
  return false;
}

function stripProviderPrefix(rawModel: string): string {
  const idx = rawModel.indexOf("/");
  return idx >= 0 ? rawModel.slice(idx + 1) : rawModel;
}

function isClaude5XHighCapable(model?: string | null): boolean {
  const raw = String(model || "");
  return /claude-(?:opus|sonnet|fable)-5/i.test(raw);
}

function isClaudeAdaptiveOnlyModel(model?: string | null): boolean {
  const raw = String(model || "").trim();
  if (!raw) return false;
  const stripped = stripProviderPrefix(raw);
  return (
    isAdaptiveThinkingOnly(raw) ||
    isAdaptiveThinkingOnly(stripped) ||
    /claude-(?:opus-4[-.](?:7|8)|(?:opus|sonnet|fable)-5)/i.test(raw)
  );
}

function modelRejectsThinkingDisabled(model?: string | null): boolean {
  const raw = String(model || "").trim();
  if (!raw) return false;
  const stripped = stripProviderPrefix(raw);
  return Boolean(
    getModelSpec(raw)?.rejectsThinkingDisabled || getModelSpec(stripped)?.rejectsThinkingDisabled
  );
}

/**
 * Sanitize combo-injected `output_config.effort` / `thinking` when the target itself
 * is a native Claude / Anthropic Messages endpoint (`targetFormat === "claude"`).
 * Operates copy-on-write on `output_config` / `thinking` and only runs when
 * `hasComboStepEffort(body)` is true, leaving non-combo requests untouched.
 */
export function sanitizeComboEffortForClaudeTarget(
  body: Record<string, unknown>,
  model?: string | null
): void {
  if (!hasComboStepEffort(body)) return;

  const existingOutputCfg =
    body.output_config &&
    typeof body.output_config === "object" &&
    !Array.isArray(body.output_config)
      ? (body.output_config as Record<string, unknown>)
      : null;
  const rawEffort =
    existingOutputCfg && typeof existingOutputCfg.effort === "string"
      ? existingOutputCfg.effort.trim().toLowerCase()
      : "";

  const thinkingRec =
    body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)
      ? (body.thinking as Record<string, unknown>)
      : null;

  const stripInjectedEffort = () => {
    if (!existingOutputCfg || existingOutputCfg.effort === undefined) return;
    const { effort: _removed, ...rest } = existingOutputCfg;
    if (Object.keys(rest).length === 0) {
      delete body.output_config;
    } else {
      const nextCfg = { ...rest };
      body.output_config = nextCfg;
      markComboStepEffort(body, nextCfg);
    }
  };

  // 1. Respect explicit client `thinking: { type: "disabled" }`
  if (thinkingRec?.type === "disabled") {
    stripInjectedEffort();
    if (modelRejectsThinkingDisabled(model)) {
      delete body.thinking;
    }
    return;
  }

  // If translated from OpenAI -> Claude (`openaiToClaudeRequest` maps low/medium/high
  // into `thinking: { type: "enabled", budget_tokens }` without `output_config.effort`),
  // still upgrade `enabled` -> `adaptive` when targeting an adaptive-only Claude model.
  if (!rawEffort) {
    if (thinkingRec?.type === "enabled" && isClaudeAdaptiveOnlyModel(model)) {
      const adaptiveThinking = { type: "adaptive" };
      body.thinking = adaptiveThinking;
      markComboStepEffort(body, adaptiveThinking);
    }
    return;
  }

  // 2. `none` on native Claude: remove invalid `output_config.effort = "none"`
  //    and disable thinking via `{ type: "disabled" }` (or delete on Fable 5 models
  //    that declare `rejectsThinkingDisabled: true`).
  if (rawEffort === "none") {
    stripInjectedEffort();
    if (thinkingRec && (thinkingRec.type === "enabled" || thinkingRec.type === "adaptive")) {
      if (modelRejectsThinkingDisabled(model)) {
        delete body.thinking;
      } else {
        const disabledThinking = { type: "disabled" };
        body.thinking = disabledThinking;
        markComboStepEffort(body, disabledThinking);
      }
    }
    return;
  }

  // 3. Clamp non-Anthropic effort tiers (`minimal` -> `low`, `xhigh` -> `high` unless Claude 5)
  let claudeEffort = rawEffort;
  if (claudeEffort === "minimal") {
    claudeEffort = "low";
  } else if (claudeEffort === "xhigh" && !isClaude5XHighCapable(model)) {
    claudeEffort = "high";
  }

  if (claudeEffort !== existingOutputCfg!.effort) {
    const nextCfg = { ...existingOutputCfg, effort: claudeEffort };
    body.output_config = nextCfg;
    markComboStepEffort(body, nextCfg);
  }

  // 4. Adaptive-only Claude models (Opus 4.7+/5, Sonnet 5, Fable 5) reject `budget_tokens`
  if (thinkingRec?.type === "enabled" && isClaudeAdaptiveOnlyModel(model)) {
    const adaptiveThinking = { type: "adaptive" };
    body.thinking = adaptiveThinking;
    markComboStepEffort(body, adaptiveThinking);
  }
}

/**
 * Apply a combo step's `reasoningEffort` onto an already-shallow-cloned `attemptBody`
 * without mutating any nested object owned by the caller (`deps.body`).
 */
export function applyComboStepReasoningEffort(
  attemptBody: Record<string, unknown>,
  rawEffort: unknown,
  sourceFormat?: string | null,
  targetOptions?: { targetFormat?: string | null; targetModel?: string | null }
): void {
  const stepEffort = typeof rawEffort === "string" ? rawEffort.trim().toLowerCase() : "";
  if (!stepEffort || !COMBO_STEP_EFFORT_PATTERN.test(stepEffort)) {
    return;
  }

  const isClaudeBody =
    sourceFormat === "claude" ||
    (sourceFormat == null &&
      (attemptBody.thinking !== undefined ||
        attemptBody.output_config !== undefined ||
        attemptBody.anthropic_version !== undefined ||
        attemptBody["anthropic-version"] !== undefined ||
        typeof attemptBody.system === "string" ||
        Array.isArray(attemptBody.system)));

  if (isClaudeBody) {
    const existingOutputCfg =
      attemptBody.output_config &&
      typeof attemptBody.output_config === "object" &&
      !Array.isArray(attemptBody.output_config)
        ? (attemptBody.output_config as Record<string, unknown>)
        : {};
    const nextOutputCfg = { ...existingOutputCfg, effort: stepEffort };
    attemptBody.output_config = nextOutputCfg;
    delete attemptBody.reasoning_effort;
    markComboStepEffort(attemptBody, nextOutputCfg);
    if (targetOptions?.targetFormat === "claude") {
      sanitizeComboEffortForClaudeTarget(attemptBody, targetOptions.targetModel);
    }
    return;
  }

  const openAiEffort = stepEffort === "max" ? "xhigh" : stepEffort;

  const isResponsesBody =
    sourceFormat === "openai-responses" ||
    (sourceFormat == null &&
      (attemptBody.input !== undefined ||
        attemptBody.max_output_tokens !== undefined ||
        attemptBody.previous_response_id !== undefined ||
        (attemptBody.reasoning !== undefined &&
          typeof attemptBody.reasoning === "object" &&
          !Array.isArray(attemptBody.reasoning))));

  if (isResponsesBody) {
    const existingReasoning =
      attemptBody.reasoning &&
      typeof attemptBody.reasoning === "object" &&
      !Array.isArray(attemptBody.reasoning)
        ? (attemptBody.reasoning as Record<string, unknown>)
        : {};
    const nextReasoning = { ...existingReasoning, effort: openAiEffort };
    attemptBody.reasoning = nextReasoning;
    delete attemptBody.reasoning_effort;
    markComboStepEffort(attemptBody, nextReasoning);
    return;
  }

  attemptBody.reasoning_effort = openAiEffort;
  // Hybrid OpenAI body with pre-existing `reasoning` object: clone & update it too so
  // `promoteStrayReasoningEffort` on Responses targets never ignores `openAiEffort`.
  if (
    attemptBody.reasoning &&
    typeof attemptBody.reasoning === "object" &&
    !Array.isArray(attemptBody.reasoning)
  ) {
    const nextReasoning = {
      ...(attemptBody.reasoning as Record<string, unknown>),
      effort: openAiEffort,
    };
    attemptBody.reasoning = nextReasoning;
    markComboStepEffort(attemptBody, nextReasoning);
  }
  if (
    attemptBody.thinking &&
    typeof attemptBody.thinking === "object" &&
    !Array.isArray(attemptBody.thinking)
  ) {
    // Clone `thinking` before marking so `deps.body.thinking` is never added to WeakSet!
    const nextThinking = { ...(attemptBody.thinking as Record<string, unknown>) };
    attemptBody.thinking = nextThinking;
    markComboStepEffort(attemptBody, nextThinking);
  } else {
    markComboStepEffort(attemptBody);
  }
}
