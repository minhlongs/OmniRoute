/**
 * Request-contract guards for the Gemini Web executor (#9356).
 *
 * gemini-web is not an API client. It launches Playwright, types ONE flat
 * prompt string into the gemini.google.com `.ql-editor` contenteditable,
 * presses Enter, and captures the first `StreamGenerate` response off the page
 * (see ../gemini-web.ts). There is no JSON request body on the wire, which
 * makes two OpenAI controls structurally impossible to honor:
 *
 *   • `reasoning_effort` — no field exists to carry a thinking budget. Unlike
 *     deepseek-web or perplexity-web, which post a real payload and can flip a
 *     `thinking_enabled` flag or swap the model preference, there is nothing
 *     here to set.
 *   • forced `tool_choice` — the tools support gemini-web does have is the
 *     prompt-emulation shim (`translator/webTools.ts`, #7286): it ASKS the
 *     model, in prose, to answer with `<tool>{...}</tool>` and parses whatever
 *     comes back. That is best-effort by construction. "required" / "any" /
 *     a named function is a GUARANTEE, and a prompt cannot make one.
 *
 * Before this module both were accepted and quietly ignored, so an agent got a
 * 200 with `finish_reason: "stop"`, no `reasoning_content`, and `tool_calls: []`
 * and concluded its requirements had been met (#9356). Failing the request is
 * the honest answer: the caller can drop the control, or route to a model that
 * actually implements it.
 *
 * Deliberately NOT rejected — these are already satisfied or already work:
 *   • `reasoning_effort: "none" | "minimal"` — asking for as little reasoning as
 *     possible is something a non-thinking provider trivially complies with.
 *   • `tool_choice: "auto" | "none"` and plain `tools[]` — the #7286 emulation
 *     path, which several shipped combos depend on (#5240, #8488). Untouched.
 *
 * Pure and dependency-free so the whole contract is unit-testable without a
 * browser.
 */

/** `error.code` on every compatibility rejection raised here. */
export const GEMINI_WEB_UNSUPPORTED_CONTROL_CODE = "unsupported_control_for_provider";

/** Effort levels a non-thinking provider already complies with. */
const SATISFIED_EFFORT_LEVELS = new Set(["none", "minimal"]);

/** `tool_choice` strings that demand a tool call rather than merely offering one. */
const FORCING_TOOL_CHOICE_STRINGS = new Set(["required", "any"]);

/** `tool_choice: { type }` values that pin the model to a specific/any tool. */
const FORCING_TOOL_CHOICE_TYPES = new Set(["function", "tool", "any"]);

export interface GeminiWebCapabilityViolation {
  /** Which request field could not be honored. */
  param: "reasoning_effort" | "tool_choice";
  /** Client-facing explanation — already safe to put in a response body. */
  message: string;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

/**
 * True when `tool_choice` demands a tool call. Covers the OpenAI strings
 * ("required"), the Anthropic-flavored ones the translators also emit ("any"),
 * and the object forms that name a function or force any tool. "auto" / "none"
 * and every unrecognized shape are treated as non-forcing — this guard only
 * blocks contracts it is certain gemini-web cannot keep.
 */
export function isForcingToolChoice(toolChoice: unknown): boolean {
  const asString = normalizeString(toolChoice);
  if (asString) return FORCING_TOOL_CHOICE_STRINGS.has(asString);

  if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const type = normalizeString((toolChoice as Record<string, unknown>).type);
    return type !== null && FORCING_TOOL_CHOICE_TYPES.has(type);
  }

  return false;
}

/** True when `reasoning_effort` asks for MORE thinking than "none at all". */
export function requestsThinkingBudget(reasoningEffort: unknown): boolean {
  const effort = normalizeString(reasoningEffort);
  if (effort === null) return false;
  return !SATISFIED_EFFORT_LEVELS.has(effort);
}

/**
 * Trailing effort tier a router may append to a gemini-web model id
 * (`gemini-4-argon-high`, `gemini-3.8-flash-medium`). Longest suffix first so
 * `-xhigh` can never be mistaken for `-high` with a stray `x`.
 */
const GEMINI_WEB_EFFORT_TIER_RE = /-(?:xhigh|high|medium|low)$/i;

/**
 * Collapse an effort-tier model id onto the base model gemini-web can drive.
 *
 * The tier is a ROUTER concept (combo / effort-variant resolution), not a
 * gemini.google.com model: there is no thinking control to set, so
 * `gemini-4-argon-high` and `gemini-4-argon` are the same upstream request.
 * Ids that merely contain a tier word (`lowrider-pro`) are untouched — only a
 * trailing `-<tier>` token matches. Mirrors AIClient2API, which models the same
 * tiers as `thinkingLevel` on the reasoning-capable cloudcode-pa upstream only.
 */
export function stripGeminiWebEffortTier(model: string): string {
  if (typeof model !== "string") return "";
  return model.trim().replace(GEMINI_WEB_EFFORT_TIER_RE, "");
}

/**
 * Drop `reasoning_effort` from a request before the capability guard runs.
 *
 * Returns a shallow COPY — the caller's body is never mutated — plus the value
 * that was dropped, so the executor can log why the control vanished.
 * `none`/`minimal` are already compliant and stay in place, and a body without
 * the field is returned by reference (no allocation on the common path).
 *
 * Rationale (2026-11-03, supersedes the #9356 rejection for this field): the
 * effort is injected by the router, not asked of gemini-web by the caller, and
 * every agentic client arrives carrying one. `checkGeminiWebUnsupportedControls`
 * still rejects it for any caller that bypasses this scrub — the executor is
 * the layer that decides to swallow it.
 */
export function stripGeminiWebReasoningEffort(body: Record<string, unknown> | null | undefined): {
  body: Record<string, unknown>;
  stripped: string | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body: {}, stripped: null };
  }
  if (!requestsThinkingBudget(body.reasoning_effort)) {
    return { body, stripped: null };
  }
  const { reasoning_effort: dropped, ...rest } = body;
  return { body: rest, stripped: normalizeString(dropped) };
}

/**
 * Inspect an OpenAI-shaped request body for controls gemini-web cannot honor.
 * Returns the first violation found, or `null` when the request is servable.
 *
 * `reasoning_effort` is checked before `tool_choice` only for determinism; a
 * request carrying both is rejected either way.
 *
 * NOTE: both executors scrub `reasoning_effort` via
 * `stripGeminiWebReasoningEffort()` before calling this, so in the request
 * pipeline only `tool_choice` can still trip. The effort branch is kept for
 * direct callers of the pure function.
 */
export function checkGeminiWebUnsupportedControls(
  body: Record<string, unknown> | null | undefined
): GeminiWebCapabilityViolation | null {
  if (!body || typeof body !== "object") return null;

  if (requestsThinkingBudget(body.reasoning_effort)) {
    return {
      param: "reasoning_effort",
      message:
        'Model provider "gemini-web" does not support "reasoning_effort". It drives the ' +
        "gemini.google.com web UI through a typed prompt and has no thinking-budget control " +
        'to set, so any effort above "minimal" would be silently ignored. Remove ' +
        '"reasoning_effort" (or send "none"/"minimal") or route to a reasoning-capable model.',
    };
  }

  if (isForcingToolChoice(body.tool_choice)) {
    return {
      param: "tool_choice",
      message:
        'Model provider "gemini-web" cannot guarantee a forced tool call. Its tool support is ' +
        "prompt-emulated — the model is asked to emit a tool block and may answer with prose " +
        'instead — so "tool_choice" values that require one ("required", "any", or a named ' +
        'function) cannot be honored. Use "auto" to keep best-effort tool calling, or route to ' +
        "a model with native function calling.",
    };
  }

  return null;
}
