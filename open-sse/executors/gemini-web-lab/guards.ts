import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { buildErrorBody } from "../../utils/error.ts";
import { prepareToolMessages } from "../../translator/webTools.ts";
import { buildGeminiPrompt } from "../gemini-web.ts";
import {
  checkGeminiWebUnsupportedControls,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
  stripGeminiWebReasoningEffort,
} from "../gemini-web/capabilities.ts";

export const GEMINI_WEB_LAB_DISABLED_CODE = "gemini_web_lab_disabled";
export const GEMINI_WEB_LAB_LOOPBACK_CODE = "non_loopback_lab_endpoint";
export const GEMINI_WEB_LAB_MODEL_CODE = "unsupported_model_for_provider";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const GEMINI_WEB_LAB_MODEL_CATEGORIES: Readonly<Record<string, number>> = {
  "gemini-3-pro": 1,
  "gemini-3-flash": 2,
  "gemini-2.5-pro": 3,
  "gemini-2.5-flash": 4,
  "gemini-2.5-flash-thinking": 5,
};

function makeJsonError(status: number, message: string, code: string): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(status, message, undefined, {
        type: status === 403 ? "permission_error" : "invalid_request_error",
        code,
      })
    ),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export function assertGeminiWebLabEnabled(): Response | null {
  let enabled = false;
  try {
    enabled = isFeatureFlagEnabled("GEMINI_WEB_LAB_ENABLED");
  } catch {
    const raw = (process.env.GEMINI_WEB_LAB_ENABLED || "").trim().toLowerCase();
    enabled = raw === "true" || raw === "1" || raw === "yes";
  }
  if (enabled) {
    return null;
  }
  return makeJsonError(
    403,
    "GeminiWebLabExecutor is disabled by default (GEMINI_WEB_LAB_ENABLED=false).",
    GEMINI_WEB_LAB_DISABLED_CODE
  );
}

export function assertLoopbackMockEndpoint(urlStr: unknown): { url: URL } | { error: Response } {
  if (typeof urlStr !== "string" || urlStr.trim().length === 0) {
    return {
      error: makeJsonError(
        400,
        "GeminiWebLabExecutor requires a loopback http:// mockBaseUrl.",
        GEMINI_WEB_LAB_LOOPBACK_CODE
      ),
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return {
      error: makeJsonError(400, "Invalid mockBaseUrl format.", GEMINI_WEB_LAB_LOOPBACK_CODE),
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !LOOPBACK_HOSTS.has(host)
  ) {
    return {
      error: makeJsonError(
        400,
        `Refusing non-loopback or non-HTTP endpoint for GeminiWebLabExecutor: ${parsed.protocol}//${host}`,
        GEMINI_WEB_LAB_LOOPBACK_CODE
      ),
    };
  }
  return { url: parsed };
}

export function checkGeminiWebLabRequestGuards(
  model: string,
  body: Record<string, unknown> | null | undefined,
  enforceModelAllowlist = true
): Response | null {
  const capViolation = checkGeminiWebUnsupportedControls(stripGeminiWebReasoningEffort(body).body);
  if (capViolation) {
    return makeJsonError(400, capViolation.message, GEMINI_WEB_UNSUPPORTED_CONTROL_CODE);
  }
  const rf = body?.response_format as Record<string, unknown> | undefined;
  if (rf && typeof rf.type === "string" && rf.type !== "text") {
    return makeJsonError(
      400,
      `response_format.type="${rf.type}" is not supported on Gemini Web.`,
      GEMINI_WEB_UNSUPPORTED_CONTROL_CODE
    );
  }
  if (enforceModelAllowlist && !(model in GEMINI_WEB_LAB_MODEL_CATEGORIES)) {
    return makeJsonError(
      400,
      `Unsupported or unverified model "${model}" for GeminiWebLabExecutor.`,
      GEMINI_WEB_LAB_MODEL_CODE
    );
  }
  return null;
}

export function sanitizeRoleMarkers(text: string): string {
  return text.replace(
    /(^|\r?\n)\s*(System|Assistant|User|Developer|Tool|Previous conversation|Current user message)\s*:/gi,
    "$1[$2]:"
  );
}

export function composeGeminiFlatPrompt(
  body: Record<string, unknown>,
  rawMessages: Array<{ role: string; content: unknown }>
): { prompt: string; hasTools: boolean } {
  const sanitized = rawMessages.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? sanitizeRoleMarkers(m.content) : m.content,
  }));
  const { effectiveMessages: effective, hasTools } = prepareToolMessages(body, sanitized);
  const turnCount = effective.filter((m) => m.role === "user" || m.role === "assistant").length;
  if (hasTools && turnCount <= 1) {
    const systemTexts = effective
      .filter((m) => m.role === "system" && typeof m.content === "string")
      .map((m) => (m.content as string).trim())
      .filter(Boolean)
      .join("\n\n");
    const lastUser = [...effective].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
    const prompt = systemTexts ? `${systemTexts}\n\n${userText}` : userText;
    return { prompt: prompt.trim(), hasTools };
  }
  return { prompt: buildGeminiPrompt(effective).trim(), hasTools };
}
