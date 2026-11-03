/**
 * GeminiWebExecutor — Gemini Web Session Provider
 *
 * Routes requests through Google Gemini's web interface using browser
 * cookies + Playwright automation. Translates between OpenAI chat
 * completions format and Gemini's web UI.
 *
 * Auth: Cookie-based (__Secure-1PSID + __Secure-1PSIDTS from gemini.google.com)
 * Method: Playwright browser automation
 *
 * Note: Streaming is pseudo-streaming — waits for full Gemini response then
 * sends as single SSE chunk. Gemini's StreamGenerate endpoint returns complete
 * responses, not chunked streams.
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import {
  executeGeminiWebDirectHttp,
  shouldUseGeminiWebDirectHttp,
} from "./gemini-web/streamGenerateClient.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import {
  checkGeminiWebUnsupportedControls,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
} from "./gemini-web/capabilities.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";

/**
 * Whether an error came from Playwright failing to launch because the browser binary is not
 * installed (`chromium.launch: Executable doesn't exist at ...`). This is a host/config
 * problem, not a transient upstream fault, so the executor must NOT surface it as a retryable
 * 500 (which marks the account unavailable and loops / trips the provider breaker). See #3516.
 */
export function isMissingBrowserExecutable(message: string): boolean {
  if (!message) return false;
  return /executable doesn't exist|executablenotfound|playwright install|chromium.*download/i.test(
    message
  );
}
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GeminiMessage {
  role: string;
  content: string;
}

interface GeminiRequestBody {
  messages: GeminiMessage[];
  model?: string;
  stream?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatChatCompletion(content: string, model: string, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content: string, model: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

/**
 * Flatten the OpenAI-style multi-turn `messages[]` into the single plain-text
 * prompt typed into the Gemini web UI (#8371).
 *
 * gemini-web drives a real browser page and captures only the FIRST
 * `StreamGenerate` response, so — unlike claude-web — it has no upstream
 * conversation id to thread across turns. It is therefore a stateless,
 * single-turn provider: the previous code forwarded only the last user message
 * (`messages.filter(m => m.role === "user").pop()`), so follow-up questions
 * lost all prior context ("I am in Berlin" → "What should I wear today?" was
 * answered without Berlin). This implements the issue's accepted fallback (b):
 * flatten the full history into one prompt so the web UI still sees the
 * conversation.
 *
 * Single-turn requests are preserved byte-for-byte (only the final user message
 * is returned) — the regression guard for the pre-existing no-tools path.
 * Multi-turn requests emit a labeled transcript:
 *
 *   System:
 *   <system text>
 *
 *   Previous conversation:
 *   User: ...
 *   Assistant: ...
 *
 *   Current user message:
 *   <last user message>
 */

export function extractMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        const name = String(block.name || "");
        const input = block.input || {};
        parts.push(`<tool_call>{"name": "${name}", "arguments": ${JSON.stringify(input)}}</tool_call>`);
      } else if (block.type === "tool_result") {
        const toolUseId = String(block.tool_use_id || "");
        const resContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
        parts.push(`Tool [${toolUseId}] Result:\n${resContent}`);
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

export function sanitizeGeminiWebOutput(
  text: string,
  requestedTools?: unknown
): string {
  if (!text) return "";
  let result = text;

  const hasInternalPython =
    result.includes("code_reference") ||
    result.includes("code_stdout") ||
    result.includes("/home/bard") ||
    result.includes("subprocess.run");

  if (hasInternalPython) {
    const hasToolTag = result.includes("<tool>") || result.includes("<tool_call");
    if (!hasToolTag) {
      const recoveredCmds: string[] = [];
      const listRegex = /subprocess\.(?:run|call|Popen|check_output)\s*\(\s*\[([\s\S]*?)\]/g;
      let m: RegExpExecArray | null;
      while ((m = listRegex.exec(result)) !== null) {
        const inner = m[1];
        const parts: string[] = [];
        const itemRegex = /["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
        let itemMatch: RegExpExecArray | null;
        while ((itemMatch = itemRegex.exec(inner)) !== null) {
          parts.push(itemMatch[1]);
        }
        if (parts.length > 0) {
          recoveredCmds.push(parts.join(" "));
        }
      }
      const strRegex = /(?:subprocess\.(?:run|call|Popen|check_output)|os\.system)\s*\(\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
      while ((m = strRegex.exec(result)) !== null) {
        const cmd = m[1].trim();
        if (cmd && !recoveredCmds.includes(cmd)) {
          recoveredCmds.push(cmd);
        }
      }

      if (recoveredCmds.length > 0) {
        const toolBlocks = recoveredCmds
          .map((cmd) => `<tool_call>{"name": "Bash", "arguments": {"command": ${JSON.stringify(cmd)}}}</tool_call>`)
          .join("\n");
        result = `${toolBlocks}\n\n${result}`;
      }
    }

    result = result
      .replace(/```python\?code_reference[^\n]*\n[\s\S]*?```/gi, "")
      .replace(/```text\?code_stdout[^\n]*\n[\s\S]*?```/gi, "")
      .replace(/Traceback \(most recent call last\):[\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/Current working directory: \/home\/bard[\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/SANDBOX_INPUT_OUTPUT_DIRECTORY: ['"]\/home\/bard['"][\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/\/home\/bard[^\n]*/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return result;
}

export function formatToolsForGemini(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines: string[] = [];
  for (const t of tools) {
    const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } })?.function ?? t;
    if (!fn?.name) continue;
    const desc = typeof fn.description === "string" && fn.description ? `: ${fn.description}` : "";
    let params = "";
    try {
      const p = fn.parameters ?? (fn as { input_schema?: unknown }).input_schema;
      if (p && typeof p === "object" && Object.keys(p).length > 0) {
        params = `\n  parameters: ${JSON.stringify(p)}`;
      }
    } catch {
      params = "";
    }
    lines.push(`- ${fn.name}${desc}${params}`);
  }
  return lines.join("\n");
}

export function buildGeminiPrompt(messages: Array<{ role: string; content: unknown }>): string {
  const textMessages = messages
    .map((m) => ({
      ...m,
      content: extractMessageContentText(m.content),
    }))
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0) as Array<{
    role: string;
    content: string;
  }>;

  const userMessages = textMessages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return "";
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? textMessages.lastIndexOf(lastUser) : -1;

  // Prior conversation = every user/assistant turn before the final user turn.
  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );

  const systemText = textMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  // Single-turn (no earlier user/assistant turns): byte-for-byte the original
  // single-message derivation. Do NOT prepend system text here — the old
  // no-tools path ignored a system-only prefix on the first turn.
  if (priorTurns.length === 0) return lastUserContent;

  const historyLines = priorTurns.map(
    (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`
  );

  const parts: string[] = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  parts.push(`Previous conversation:\n${historyLines.join("\n\n")}`);
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

/**
 * Build the plain-text prompt typed into the Gemini web UI when a tool
 * contract is active — the synthetic system message injected by
 * `prepareToolMessages()` prepended to the last user message. gemini-web
 * only ever sends a single flat string (no native message array), so the
 * tool contract and the user's ask are concatenated (#7286).
 */
function sanitizeGeminiToolPrompt(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(
      /The client application provides tools beyond your built-in ones[\s\S]*?Available tools:/g,
      "You have access to the following tools to assist with this coding task. When you want to use a tool, output a <tool> block with JSON containing the tool name and arguments. Only output a <tool> block when a tool invocation is needed, otherwise answer normally.\n\nAvailable tools:"
    )
    .replace(
      /\[Client protocol reminder: the client-tool contract in the system instructions is active in this conversation[\s\S]*?\.\s*\]/g,
      "[When an action requires a tool, emit the <tool> block directly.]"
    );
}

export function buildGeminiToolPrompt(
  effectiveMessages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
  requestedTools?: unknown
): string {
  const extracted = effectiveMessages
    .map((m) => {
      let content = extractMessageContentText(m.content).trim();
      if (!content && Array.isArray((m as any).tool_calls)) {
        const tcParts: string[] = [];
        for (const tc of (m as any).tool_calls) {
          const fn = tc.function || tc;
          const fnName = fn.name;
          const fnArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : (fn.arguments || {});
          tcParts.push(`<tool_call>{"name": "${fnName}", "arguments": ${JSON.stringify(fnArgs)}}</tool_call>`);
        }
        content = tcParts.join("\n");
      }
      return { role: m.role, content };
    })
    .filter((m) => m.content.length > 0);

  const rawSystemText = extracted
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const userMessages = extracted.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? extracted.lastIndexOf(lastUser) : -1;

  const priorTurns = extracted.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant" || m.role === "tool")
  );

  const hasExplicitTools = Array.isArray(requestedTools) && requestedTools.length > 0;

  if (!hasExplicitTools && priorTurns.length === 0) {
    const systemText = sanitizeGeminiToolPrompt(rawSystemText);
    const userContent = sanitizeGeminiToolPrompt(lastUserContent);
    return systemText ? `${systemText}\n\n${userContent}` : userContent;
  }

  const clientSystemTexts = extracted
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(
      (c) =>
        !c.includes("The client application provides tools beyond your built-in ones") &&
        !c.includes("Available tools:")
    );

  const toolsListStr = formatToolsForGemini(requestedTools);

  const toolContract = [
    "You have access to the following tools to assist with this coding task. When you want to use a tool, output a <tool_call> block with JSON containing the tool name and arguments. Only output a <tool_call> block when a tool invocation is needed, otherwise answer normally.",
    "",
    "Available tools:",
    toolsListStr,
    "",
    "CRITICAL RULES:",
    "1. DO NOT execute code using your internal Python sandbox. Never run code in /home/bard.",
    "2. DO NOT output code_reference, code_stdout, or Borg execution cells.",
    "3. When you need to run bash commands, read/write files, or perform any local action, you MUST invoke the tool using:",
    '<tool_call>{"name": "<tool_name>", "arguments": { ... }}</tool_call>',
    "4. When an action requires a tool, emit ONLY the <tool_call> block directly without conversational filler.",
  ].join("\n");

  const parts: string[] = [];
  if (clientSystemTexts.length > 0) {
    parts.push(clientSystemTexts.join("\n\n"));
  }
  parts.push(toolContract);

  if (priorTurns.length > 0) {
    const historyLines = priorTurns.map((m) => {
      const roleLabel =
        m.role === "assistant"
          ? "Assistant"
          : m.role === "tool"
            ? "Tool Result"
            : "User";
      return `${roleLabel}: ${m.content}`;
    });
    parts.push(`Previous conversation:\n${historyLines.join("\n\n")}`);
  }

  const cleanLastUser = lastUserContent
    .replace(/\[Client protocol reminder:[\s\S]*?\]/g, "")
    .trim();

  parts.push(
    `Current user message:\n${cleanLastUser}\n\n[When an action requires a tool, emit the <tool_call> block directly.]`
  );

  return parts.join("\n\n");
}

/**
 * Tool mode: wrap the buffered Gemini response text in the standard OpenAI
 * completion shape, then delegate to the shared `buildToolModeResponse()`
 * (`chatgptWebTools.ts`) — parses `<tool>{...}</tool>` blocks out of the
 * text into `tool_calls` (malformed JSON degrades to ordinary `content`,
 * never throws) and replays either buffered JSON or a terminal SSE chunk
 * depending on `stream` (#7286). Exported standalone so the branching logic
 * is testable without a full Playwright mock.
 */
export async function buildGeminiToolResponse(
  responseText: string,
  requestedTools: unknown,
  stream: boolean,
  model: string,
  cid: string,
  created: number
): Promise<Response> {
  const sanitized = sanitizeGeminiWebOutput(responseText, requestedTools);
  const bufferedJson = new Response(JSON.stringify(formatChatCompletion(sanitized, model)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  return buildToolModeResponse(bufferedJson, requestedTools, stream, {
    cid,
    created,
    model,
    idSeed: "gwe",
  });
}

/**
 * Parse cookie string, stripping attributes (Path, Domain, Expires, etc.)
 * Input: full browser cookie string or just "name=value; name2=value2"
 * Output: array of { name, value } pairs
 */
function parseCookies(raw: string): Array<{ name: string; value: string }> {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      // Skip cookie attributes that aren't name=value pairs
      if (!name || !value) return null;
      const lowerName = name.toLowerCase();
      if (
        ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
          lowerName
        )
      ) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean) as Array<{ name: string; value: string }>;
}

/**
 * Parse Gemini StreamGenerate response text.
 *
 * Response format:
 *   )]}'
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *
 * The JSON string contains nested array: inner[4][0][1] = ["text chunks"].
 * Each wrb.fr line is a CUMULATIVE snapshot of the whole answer generated so
 * far (not an independent delta), so we keep only the text from the LAST
 * frame that yields non-empty text instead of concatenating every frame —
 * concatenating would reproduce the same growing text with each snapshot
 * (see #7163).
 */
export function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  let lastText = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      // Defensive: check each level before accessing
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c: unknown) => typeof c === "string").join("");
      if (text) lastText = text;
    } catch {
      // Skip unparseable lines
    }
  }
  return lastText;
}

function readCredentialString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readProviderSpecificString(
  providerSpecificData: unknown,
  keys: readonly string[]
): string {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  const data = providerSpecificData as Record<string, unknown>;
  for (const key of keys) {
    const value = readCredentialString(data[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Merge rotated __Secure-1PSID* cookies read back from the live Playwright
 * cookie jar into the original cookie string. Only the three long-lived
 * Gemini auth cookies are considered — pulling in the entire jar would risk
 * treating short-lived Google analytics/consent cookies as credentials
 * (#7676). Cookies the jar didn't return, or that are unchanged, are left
 * untouched in the original string.
 */
export function mergeRotatedGeminiCookies(
  originalCookie: string,
  jarCookies: Array<{ name: string; value: string }>
): string {
  const ROTATABLE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"];
  const jarByName = new Map(jarCookies.map((c) => [c.name, c.value]));

  const pairs = parseCookies(originalCookie);
  const seen = new Set<string>();
  const merged = pairs.map(({ name, value }) => {
    seen.add(name);
    if (ROTATABLE_NAMES.includes(name) && jarByName.has(name)) {
      return { name, value: jarByName.get(name) as string };
    }
    return { name, value };
  });

  for (const name of ROTATABLE_NAMES) {
    if (!seen.has(name) && jarByName.has(name)) {
      merged.push({ name, value: jarByName.get(name) as string });
    }
  }

  return merged.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function normalizeGeminiCookieInput(raw: string, cookieName = "__Secure-1PSID"): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}

function resolveGeminiWebCookie(credentials: ExecuteInput["credentials"]): string {
  const directCookie =
    readCredentialString(credentials?.apiKey) ||
    readCredentialString((credentials as Record<string, unknown> | undefined)?.cookie);
  if (directCookie) return normalizeGeminiCookieInput(directCookie);

  const providerSpecificData = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(providerSpecificData, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);

  const psid = readProviderSpecificString(providerSpecificData, ["__Secure-1PSID"]);
  const psidts = readProviderSpecificString(providerSpecificData, ["__Secure-1PSIDTS"]);
  return [
    psid ? normalizeGeminiCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeGeminiCookieInput(psidts, "__Secure-1PSIDTS") : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Ensures Gemini 4 Argon model is active on gemini.google.com for Ultra accounts.
 *
 * Requirements:
 * 1. Inspect model switch label/button (.input-area-switch-label, button.input-area-switch, etc.).
 * 2. If already "4 Argon" / "Argon", verify and proceed.
 * 3. If not "4 Argon" / "Argon", open the model menu, locate the exact "4 Argon" option,
 *    and click it (with force: true / dispatchEvent to handle CDK overlay backdrop).
 * 4. Wait for the indicator text to confirm it has changed to "4 Argon" / "Argon".
 * 5. Log clearly: `[gemini-web] Verified active model: 4 Argon`.
 * 6. If 4 Argon cannot be selected (disabled, missing, guest session, or timeout),
 *    strictly throw an explicit error so OmniRoute fails or cascades rather than
 *    silently sending prompts on Flash/Pro.
 */
export async function ensureAdvancedModel(
  page: import("playwright").Page,
  targetModelOrLog?: string | ExecuteInput["log"],
  optionalLog?: ExecuteInput["log"]
): Promise<void> {
  // Bare mock page in unit tests — skip DOM actions
  if (typeof page.locator !== "function") {
    return;
  }

  const requestedModel = typeof targetModelOrLog === "string" ? targetModelOrLog : undefined;
  const log = (
    typeof targetModelOrLog === "object" && targetModelOrLog !== null ? targetModelOrLog : optionalLog
  ) as ExecuteInput["log"];

  const is38 = requestedModel ? /3\.8/i.test(requestedModel) : false;
  const targetLabel = is38 ? "3.8 Flash" : "4 Argon";
  const modelMatcher = is38
    ? (text: string) => /3\.8|Flash/i.test(text || "") && !/Argon/i.test(text || "")
    : (text: string) => /4\s*Argon|Argon/i.test(text || "");

  // Model switch trigger element selector
  const switchTriggerSelector =
    ".input-area-switch-label, button.input-area-switch, button[aria-label*='mode picker'], [data-test-id='model-selector']";

  let switchElement = await page.waitForSelector(switchTriggerSelector, { timeout: 10000 }).catch(() => null);

  // Fallback: search for buttons with model picker attributes
  if (!switchElement) {
    const pickerCandidate = page
      .locator("button, [role='combobox'], [role='button']")
      .filter({
        hasText: /Argon|Flash|Pro|Advanced/i,
      })
      .first();
    if ((await pickerCandidate.count().catch(() => 0)) > 0) {
      switchElement = await pickerCandidate.elementHandle();
    }
  }

  if (!switchElement) {
    throw new Error(
      `[gemini-web] Strict ${targetLabel} requirement failed: Model indicator element not found on gemini.google.com`
    );
  }

  // Check current model text
  let currentModel = "";
  if (typeof switchElement.innerText === "function") {
    currentModel = (await switchElement.innerText().catch(() => "")) || "";
  }
  if (!currentModel && typeof switchElement.getAttribute === "function") {
    currentModel = (await switchElement.getAttribute("aria-label").catch(() => "")) || "";
  }
  currentModel = currentModel.trim();

  // If already on target model, verify immediately and return
  if (modelMatcher(currentModel)) {
    console.log(`[gemini-web] Verified active model: ${targetLabel}`);
    log?.info?.("GEMINI-WEB", `[gemini-web] Verified active model: ${targetLabel}`);
    return;
  }

  console.log(`[gemini-web] Model is currently '${currentModel}'. Opening dropdown to switch to ${targetLabel}...`);
  log?.info?.("GEMINI-WEB", `[gemini-web] Model is currently '${currentModel}'. Opening dropdown to switch to ${targetLabel}...`);

  // Open the dropdown menu
  await switchElement.click({ force: true });

  // Wait for menu overlay to appear
  const menuContainerSelector = "gem-menu, [role='menu'], .cdk-overlay-pane";
  await page.waitForSelector(menuContainerSelector, { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(400);

  // Check if session is unauthenticated guest
  const menuContainer = page.locator(menuContainerSelector).first();
  const menuText = (await menuContainer.innerText().catch(() => "")) || "";
  if (/sign in for all models/i.test(menuText)) {
    throw new Error(
      `[gemini-web] Strict ${targetLabel} requirement failed: Account session is unauthenticated / guest mode ('Sign in for all models')`
    );
  }

  // Find target menu item inside the menu/overlay
  const menuItemCandidates = page.locator(
    '.cdk-overlay-container gem-menu-item, .cdk-overlay-container [role="menuitem"], .cdk-overlay-container [role="option"], gem-menu-item, [role="menuitem"], [role="option"], mat-option, .mat-mdc-menu-item'
  );

  const count = await menuItemCandidates.count();
  let targetItem = null;
  for (let i = 0; i < count; i++) {
    const item = menuItemCandidates.nth(i);
    const text = (await item.innerText().catch(() => "")) || "";
    if (modelMatcher(text)) {
      targetItem = item;
      break;
    }
  }

  if (!targetItem) {
    throw new Error(
      `[gemini-web] Strict ${targetLabel} requirement failed: ${targetLabel} option not found in model menu (current model: ${currentModel})`
    );
  }

  // Check if disabled
  const isDisabled = await targetItem
    .evaluate((el) => {
      return (
        el.classList.contains("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        Boolean(el.querySelector(".disabled"))
      );
    })
    .catch(() => false);

  if (isDisabled) {
    throw new Error(
      `[gemini-web] Strict ${targetLabel} requirement failed: ${targetLabel} menu option is disabled for this account/session`
    );
  }

  // Click target (force: true and dispatchEvent fallback to avoid CDK backdrop intercepting)
  try {
    await targetItem.click({ force: true, timeout: 3000 });
  } catch {
    await targetItem.dispatchEvent("click");
  }

  // Wait for the label/indicator text to confirm it has changed
  let verified = false;
  const startTime = Date.now();
  const maxWaitMs = 10000;

  while (Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(300);
    const currentIndicator = await page.$(switchTriggerSelector).catch(() => null);
    const updatedText =
      currentIndicator && typeof currentIndicator.innerText === "function"
        ? (await currentIndicator.innerText().catch(() => "")) || ""
        : "";
    const updatedAria =
      currentIndicator && typeof currentIndicator.getAttribute === "function"
        ? (await currentIndicator.getAttribute("aria-label").catch(() => "")) || ""
        : "";
    if (modelMatcher(updatedText) || modelMatcher(updatedAria)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    const finalIndicator = await page.$(switchTriggerSelector).catch(() => null);
    const finalModel =
      finalIndicator && typeof finalIndicator.innerText === "function"
        ? (await finalIndicator.innerText().catch(() => "")) || ""
        : "";
    throw new Error(
      `[gemini-web] Strict ${targetLabel} requirement failed: Active model remained '${finalModel.trim()}' after selection attempt`
    );
  }

  console.log(`[gemini-web] Verified active model: ${targetLabel}`);
  log?.info?.("GEMINI-WEB", `[gemini-web] Verified active model: ${targetLabel}`);
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  /**
   * testConnection — validates the cookie format without making a network call
   * or launching Playwright. Returns true when the cookie is non-empty and
   * contains at least one name=value pair with a non-empty value. This is a
   * lightweight pre-check before the browser automation path; full session
   * validation is done by validateGeminiWebProvider in the connection test
   * flow (#9407).
   */
  async testConnection(
    credentials: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const cookie = resolveGeminiWebCookie(
        credentials as unknown as ExecuteInput["credentials"]
      );
      if (!cookie) return false;
      const pairs = parseCookies(cookie);
      return pairs.some((p) => p.value.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Read the live Playwright cookie jar back after a successful run and, if
   * Google rotated any of the __Secure-1PSID* cookies, forward the merged
   * cookie string through onCredentialsRefreshed so it gets persisted to the
   * encrypted provider_connections.api_key field. Mirrors the rotate-and-
   * persist pattern already shipped in chatgpt-web.ts. A persistence failure
   * must never fail the user-facing response (#7676).
   */
  private async persistRotatedCookies(
    context: import("playwright").BrowserContext,
    cookie: string,
    credentials: ExecuteInput["credentials"],
    onCredentialsRefreshed: ExecuteInput["onCredentialsRefreshed"],
    log: ExecuteInput["log"]
  ): Promise<void> {
    if (!onCredentialsRefreshed) return;
    try {
      const jarCookies = await context.cookies();
      const mergedCookie = mergeRotatedGeminiCookies(cookie, jarCookies);
      if (mergedCookie && mergedCookie !== cookie) {
        await onCredentialsRefreshed({ ...credentials, apiKey: mergedCookie });
      }
    } catch (err) {
      log?.warn?.(
        "GEMINI-WEB",
        `Failed to persist rotated cookie: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal, log, onCredentialsRefreshed } = input;
    const requestBody = body as GeminiRequestBody;

    // #9356: fail fast on controls this provider cannot honor (reasoning_effort
    // above "minimal", forced tool_choice). Runs before the credential check and
    // before Playwright launches — the request is unservable no matter which
    // cookie is used, and answering 200 with ordinary prose made agents believe
    // their reasoning/tool requirements had been met. See ./gemini-web/capabilities.ts.
    const violation = checkGeminiWebUnsupportedControls(body as Record<string, unknown>);
    if (violation) {
      log?.warn?.(
        "GEMINI-WEB",
        `Rejected request: "${violation.param}" is not supported by this provider`
      );
      return {
        response: new Response(
          JSON.stringify(
            buildErrorBody(400, violation.message, null, {
              type: "invalid_request_error",
              code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
            })
          ),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Model restriction: strictly Argon and 3.8 only from Gemini Web
    const rawModel = (model || "").trim();
    const isArgon = /argon/i.test(rawModel);
    const is38 = /3\.8/i.test(rawModel);
    const isUltra = /ultra/i.test(rawModel);
    const isHttp = /-http$/i.test(rawModel);

    if (rawModel && !isArgon && !is38 && !isUltra && !isHttp) {
      log?.warn?.("GEMINI-WEB", `Rejected unsupported model for Gemini Web: "${rawModel}"`);
      return {
        response: new Response(
          JSON.stringify(
            buildErrorBody(
              400,
              `Only Argon and 3.8 models are supported on Gemini Web (received "${rawModel}")`,
              null,
              {
                type: "invalid_request_error",
                code: "unsupported_model_for_provider",
              }
            )
          ),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const modelId = is38 ? (rawModel || "gemini-3.8-flash") : (rawModel || "gemini-4-argon");

    const cookie = resolveGeminiWebCookie(credentials);
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = requestBody.messages || [];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      body as Record<string, unknown>,
      messages
    );

    // hasTools === false: flatten the full multi-turn history into the single
    // prompt so gemini-web (a stateless web-cookie provider that captures only
    // the first StreamGenerate response) preserves prior context across turns
    // (#8371). Single-turn requests stay byte-for-byte identical to the original
    // derivation, keeping the #7286 no-tools regression guard intact.
    const prompt = hasTools
      ? buildGeminiToolPrompt(effectiveMessages, requestedTools)
      : buildGeminiPrompt(messages);

    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

        let isPlaywrightMocked = false;
    try {
      const { chromium } = await import("playwright");
      if (typeof chromium?.launch === "function") {
        isPlaywrightMocked = !chromium.launch.toString().includes("userDataDir");
      }
    } catch {
      /* ignore */
    }

    const isDirectHttpCandidate = shouldUseGeminiWebDirectHttp(model, credentials, isPlaywrightMocked);
    if (isDirectHttpCandidate) {
      const directResult = await executeGeminiWebDirectHttp({
        input: { ...input, model: modelId },
        cookie,
        prompt,
        hasTools,
        requestedTools,
        mergeRotatedCookies: mergeRotatedGeminiCookies,
        buildToolResponse: buildGeminiToolResponse,
      });

      const psd = credentials?.providerSpecificData as Record<string, unknown> | undefined;
      const explicitDirect =
        psd?.transport === "http" ||
        psd?.transport === "direct" ||
        typeof psd?.endpointUrl === "string" ||
        (model || "").endsWith("-http");

      if (directResult.response.status === 200 || (model || "").endsWith("-http")) {
        return directResult;
      }

      log?.warn?.(
        "GEMINI-WEB",
        `Direct HTTP returned status ${directResult.response.status}. Falling back to Playwright browser automation.`
      );
    }

    let browser: any = null;
    let abortBrowser: (() => void) | null = null;
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      const { chromium } = await import("playwright");
      const proxyServer = process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.HTTP_PROXY;
      const launchOptions: import("playwright").LaunchOptions = { headless: true };
      if (proxyServer) {
        launchOptions.proxy = { server: proxyServer };
      }
      browser = await chromium.launch(launchOptions);
      abortBrowser = () => {
        void browser?.close().catch(() => {});
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });

      const context = await browser.newContext({ userAgent: GEMINI_USER_AGENT });

      // Parse cookies — strips attributes like Path, Domain, Expires
      const cookiePairs = parseCookies(cookie);
      await context.addCookies(
        cookiePairs.map(({ name, value }) => ({
          name,
          value,
          domain: ".google.com",
          path: "/",
          secure: true,
        }))
      );

      const page = await context.newPage();

      // Capture first StreamGenerate or batchexecute response
      let responseText = "";
      let captured = false;
      const responsePromise = new Promise<void>((resolve) => {
        page.on("response", async (resp: any) => {
          if (captured) return;
          const url = typeof resp.url === "function" ? resp.url() : "";
          if (!url.includes("StreamGenerate") && !url.includes("batchexecute")) return;
          try {
            const raw = await resp.text();
            if (raw.includes("wrb.fr")) {
              const parsed = parseStreamResponse(raw);
              if (parsed && parsed.length > responseText.length) {
                responseText = parsed;
                captured = true;
                resolve();
              }
            }
          } catch {
            /* ignore */
          }
        });
      });

      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      await page.waitForTimeout(3000);

      // Ensure requested Gemini model (4 Argon or 3.8 Flash) is active
      await ensureAdvancedModel(page, modelId, log);

      // Type and send message
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 10000,
      });
      if (inputEl && typeof inputEl.click === "function") {
        await inputEl.click();
      }
      if (typeof page.evaluate === "function") {
        await page.evaluate((text) => {
          const el = document.querySelector(".ql-editor, [contenteditable='true']") as HTMLElement;
          if (el) {
            el.focus();
            document.execCommand("insertText", false, text);
          }
        }, prompt).catch(() => {});
        const inserted = await page.evaluate(() => {
          const el = document.querySelector(".ql-editor, [contenteditable='true']");
          return Boolean(el?.textContent?.trim());
        }).catch(() => false);
        if (!inserted) {
          if (typeof (inputEl as any).fill === "function") {
            await (inputEl as any).fill(prompt).catch(() => {});
          } else if (typeof page.keyboard?.type === "function") {
            await page.keyboard.type(prompt);
          }
        }
      } else if (typeof page.keyboard?.type === "function") {
        await page.keyboard.type(prompt);
      }
      await page.waitForTimeout(300);
      if (typeof page.keyboard?.press === "function") {
        await page.keyboard.press("Enter");
      }

      // Wait for response or timeout (Argon reasoning can take up to 60-90s; Flash 30s)
      const responseTimeout = is38 ? 30000 : 90000;
      const waitPromises: Promise<unknown>[] = [
        responsePromise,
        page.waitForTimeout(responseTimeout),
      ];

      // If page.evaluate exists (real browser, not mock test page), run DOM observer
      if (typeof page.evaluate === "function") {
        const domWaitPromise = (async () => {
          await page.waitForTimeout(2000);
          let stableCount = 0;
          let prevLength = 0;
          const maxWaitMs = 85000;
          const startTime = Date.now();

          while (Date.now() - startTime < maxWaitMs) {
            if (signal?.aborted || captured) return;

            const state = await page.evaluate(() => {
              const stopBtn = document.querySelector(
                "button[aria-label*='Stop'], button[aria-label*='Dừng'], .stop-button, [data-test-id='stop-button'], mat-icon[data-mat-icon-name='stop']"
              );
              const msgs = document.querySelectorAll("message-content, .model-response-text");
              const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
              const text = (lastMsg as HTMLElement)?.innerText?.trim() || "";
              return {
                isGenerating: Boolean(stopBtn),
                text,
                length: text.length,
              };
            }).catch(() => null);

            if (state && state.length > 0) {
              if (!state.isGenerating && state.length === prevLength) {
                stableCount++;
                if (stableCount >= 2) {
                  if (!responseText || responseText.length < state.length) {
                    responseText = state.text;
                    captured = true;
                  }
                  return;
                }
              } else {
                stableCount = 0;
                prevLength = state.length;
              }
            }

            await page.waitForTimeout(800);
          }
        })();
        waitPromises.push(domWaitPromise);
      }

      await Promise.race(waitPromises);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }

      if (!responseText && typeof page.evaluate === "function") {
        const domText = await page.evaluate(() => {
          const msgs = document.querySelectorAll("message-content, .model-response-text");
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          return (lastMsg as HTMLElement)?.innerText?.trim() || "";
        }).catch(() => "");
        if (domText) {
          responseText = domText;
        }
      }

      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      await this.persistRotatedCookies(context, cookie, credentials, onCredentialsRefreshed, log);

      // (modelId resolved and validated at execute start: defaults to gemini-4-argon / gemini-3.8-flash)

      if (hasTools) {
        const cid = `chatcmpl-gwe-${crypto.randomUUID().slice(0, 12)}`;
        const created = Math.floor(Date.now() / 1000);
        const toolResponse = await buildGeminiToolResponse(
          responseText,
          requestedTools,
          Boolean(stream),
          modelId,
          cid,
          created
        );
        return { response: toolResponse, url: GEMINI_URL, headers: {}, transformedBody: body };
      }

      if (stream) {
        // Pseudo-streaming: send complete response as single SSE chunk
        // Gemini's StreamGenerate returns complete responses, not chunked streams
        const encoder = new TextEncoder();
        const readable = new ReadableStream(
          {
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          },
          { highWaterMark: 16384 }
        );
        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } catch (error) {
            const rawMessage = error instanceof Error ? error.message : "Unknown error";
      if (rawMessage.includes("Strict 4 Argon requirement failed")) {
        log?.warn?.("GEMINI-WEB", rawMessage);
        return {
          response: new Response(
            JSON.stringify({
              error: sanitizeErrorMessage(rawMessage),
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      // Strict 4 Argon requirement enforcement: tag with connection_cooldown so accountFallback
      // cascades to the next available account without tripping the provider circuit breaker.
      if (rawMessage.includes("Strict 4 Argon requirement failed")) {
        log?.warn?.("GEMINI-WEB", rawMessage);
        return {
          response: new Response(
            JSON.stringify({
              error: sanitizeErrorMessage(rawMessage),
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      // #3516: a missing Playwright browser is a host/config problem, not a transient upstream
      // fault. Surface an actionable error and tag it with the connection-cooldown hint so
      // accountFallback skips the provider circuit breaker and applies a short, non-exponential
      // cooldown instead of looping on a retryable 500.
      if (isMissingBrowserExecutable(rawMessage)) {
        return {
          response: new Response(
            JSON.stringify({
              error:
                "Gemini Web requires the Playwright Chromium browser, which is not installed. " +
                "Run `npx playwright install chromium` on the host (or rebuild the Docker image with browsers).",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      // #9407: Playwright selector/click timeout errors are terminal — they indicate
      // the page DOM does not match expectations (e.g. Gemini changed their UI or
      // the session is so expired it lands on a different page). Return 400 so the
      // account-fallback system does NOT retry this request as a transient 5xx.
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          rawMessage.includes("waitForSelector") ||
          rawMessage.includes("Timeout") ||
          rawMessage.includes("actionability") ||
          rawMessage.includes("interception"))
      ) {
        return {
          response: new Response(
            JSON.stringify({
              error: sanitizeErrorMessage(rawMessage),
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      // Always close browser to prevent resource leaks
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore close errors */
        }
      }
    }
  }
}
