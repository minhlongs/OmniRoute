/**
 * Task-aware routing layer for combo routing.
 *
 * Derives request difficulty (light / standard / heavy / critical) from cheap,
 * local structural signals — no LLM call. Routes heavier tasks toward higher-power
 * models using a continuous `modelPowerScore`. Also provides conversation-affinity
 * sticky round-robin for prompt-cache efficiency.
 *
 * Enhanced with 4-Tier Model Allocation:
 * - Tier 1 (Critical/Frontier, Power 125-145): codex/gpt-6-astra, gemini-4-argon-high, opus-5
 * - Tier 2 (Heavy Workhorse, Power 95-115): codex/gpt-5.6-sol, claude-sonnet-5-5, argon-medium
 * - Tier 3 (Standard Coding, Power 65-85): codex/gpt-5.6-terra, gemini-3.8-flash-tiered
 * - Tier 4 (Micro/Lightweight, Power 25-45): codex/gpt-5.6-luna, gemini-3.5-flash-lite, haiku
 *
 * Prevents "dao mổ trâu giết gà" by heavily penalizing overpowered models on light & routine tasks.
 */

import { createHash } from "node:crypto";
import { getResolvedModelCapabilities } from "./modelCapabilities.ts";
import type { ResolvedComboTarget } from "./combo/types.ts";

// ── Task level constants ──────────────────────────────────────────────────────

export const TASK_LEVEL_WEIGHT = {
  light: 1,
  standard: 2,
  heavy: 3,
  critical: 4,
} as const;

export type TaskLevel = keyof typeof TASK_LEVEL_WEIGHT;

export const TASK_TARGET_POWER: Record<TaskLevel, number> = {
  light: 35,
  standard: 70,
  heavy: 105,
  critical: 135,
};

// ReDoS-safe: all alternations are fixed-length word literals under \b anchors.
export const LIGHT_TASK_RE =
  /\b(hi|hello|thanks|thank you|ping|format|rewrite|grammar|translate|summari[sz]e|short|quick|one[- ]?liner|explain briefly)\b/i;

export const AUXILIARY_TITLE_RE =
  /\b(5[- ]10 word title|brief title|short title|session title|conversation title|title for this|title summarizing|title of the chat)\b/i;

export const COMPACTION_SUMMARY_RE =
  /\b(compact conversation|summarize the conversation|summarize this chat|summarize the above|User stepped away and is coming back|Recap in under \d+ words)\b/i;

export const ADVISE_SYSTEM_RE =
  /(?:subagent_type["']?\s*:\s*["']?(?:advisor|kongming|suntzu)|^\s*You are an? (?:advisor|Kongming|Sun Tzu)\b)/i;

export const ADVISE_COMMAND_RE =
  /(?:<command-name>\/?(?:ak[-:]advise|mk[-:]advise|advise)<\/command-name>|<command-message>(?:ak[-:]advise|mk[-:]advise|advise)<\/command-message>|\[\$?(?:ak[-:]advise|mk[-:]advise|advise)\]|^\s*[\/\$]?(?:ak[-:]advise|mk[-:]advise)\b|^\s*\/advise\b|The user invoked \x60?\/(?:ak[-:]advise|mk[-:]advise|advise)\b)/i;

export const VIBE_COMMAND_RE =
  /(?:<command-name>\/?(?:ak[-:]vibe|ak[-:]vide|mk[-:]vibe|mk[-:]vide|vibe|vide|ak[-:]cook|mk[-:]cook|cook)<\/command-name>|<command-message>(?:ak[-:]vibe|ak[-:]vide|mk[-:]vibe|mk[-:]vide|vibe|vide|ak[-:]cook|mk[-:]cook|cook)<\/command-message>|\[\$?(?:ak[-:]vibe|ak[-:]vide|mk[-:]vibe|mk[-:]vide|vibe|vide|ak[-:]cook|mk[-:]cook|cook)\]|^\s*[\/\$]?(?:ak[-:]vibe|ak[-:]vide|mk[-:]vibe|mk[-:]vide|ak[-:]cook|mk[-:]cook)\b|^\s*\/(?:vibe|vide|cook)\b|The user invoked \x60?\/(?:ak[-:]vibe|ak[-:]vide|mk[-:]vibe|ak[-:]cook|mk[-:]cook)\b)/i;

export const SESSION_CONTINUATION_RE =
  /^\s*This session is being continued from a previous conversation that ran out of context\b/i;

// High-priority workflow kickoff triggers (e.g. /ak-bootstrap ... /ak-brainstorm --deep, /idea 25 bước tái cấu trúc --deep)
// Carried by Gemini 4 (antigravity/gemini-4-argon-high) during the kickoff/brainstorm framing window,
// then automatically released to Gemini 3.8 (antigravity/gemini-3.8-flash-tiered) for execution.
export const WORKFLOW_KICKOFF_RE =
  /(?:\/(?:ak|mk)[-:](?:advise|bootstrap|brainstorm|plan|research|autoresearch|strategist|architect)\b|<command-name>\/?(?:ak|mk)[-:](?:advise|bootstrap|brainstorm|plan|research|autoresearch|strategist|architect)<\/command-name>|<command-name>\/?(?:orchestrate|stitch-loop|stitch-ideate)<\/command-name>|\/(?:orchestrate|stitch-loop|stitch-ideate)\b|go\s+next\s+(?:refactor\s+)?to\s+\/(?:ak|mk)[-:]brainstorm|\b\d+\s*bước\s+tái\s+cấu\s+trúc|(?:\/idea\b|<command-name>\/?idea<\/command-name>)|^\s*Execute Phase \d+\b|Tiếp tục hoàn tất phần còn lại của kế hoạch tại \.orchestrate|(?:bootstrap\b|\bbrainstorm\b|tái\s+cấu\s+trúc\s+dự\s+án)[\s\S]{0,240}--deep\b|--deep\b[\s\S]{0,240}(?:\bbootstrap\b|\bbrainstorm\b|tái\s+cấu\s+trúc\s+dự\s+án))/i;

// /idea session & subagent detection (e.g. /idea, /mk-idea, /ak-cook ... /idea 25 bước, BizPlan OS subagent)
export const IDEA_SYSTEM_RE =
  /(?:Agentic BizPlan OS|Zero→IPO|Zero-to-IPO|subagent_type["']?\s*:\s*["']?(?:idea|bizplan))/i;

export const IDEA_PROMPT_RE =
  /(?:<command-name>\/?(?:idea|mk[-:]idea|ak[-:]idea)<\/command-name>|(?:^|[\s"'`“‘(>:])\/(?:idea|mk[-:]idea|ak[-:]idea)\b|#\s*\/idea\b|Agentic BizPlan OS|\b25[- ]?step[\s\S]{0,120}(?:Open[- ]?Core|SaaS|idea|BizPlan|blueprint|restructuring)|\b25\s*bước\s*(?:tái\s+cấu\s+trúc|chính\s+xác|open[- ]?core|idea\b))/i;

export const IDEA_FILE_PATH_RE =
  /(?:^|\/)\.mekong\/company\.json$|(?:^|\/)plans\/company-blueprint\/[^\n]+$|(?:^|\/)(?:BUSINESS_MODEL|GOAL|PRD|ROADMAP)\.md$/i;

export const SUBAGENT_IDEA_NOTIFICATION_RE =
  /<task-notification>[\s\S]*?(?:<summary>[^\n]*(?:\bidea\b|25[- ]?step|25\s*bước|Open[- ]?Core|BizPlan|company-blueprint)|executing the 25-step|chạy lại \/idea)/i;

// Planner session / subagent detection (e.g. `planner` Tech Lead subagent, `/ak-plan`, `/mk-plan`, `/plan`)
export const PLANNER_SYSTEM_RE =
  /(?:locking architecture before code is written|Tech Lead[\s\S]{0,80}locking architecture|subagent_type["']?\s*:\s*["']?planner)/i;

export const PLANNER_PROMPT_RE =
  /(?:<command-name>\/?(?:ak[-:]plan|mk[-:]plan|plan)<\/command-name>|(?:^|[\s"'`“‘(>:])\/(?:ak[-:]plan|mk[-:]plan|plan)\b|(?:lập|tạo|viết)\s+(?:kế\s+hoạch|plan)\b)/i;

export const PLAN_FILE_PATH_RE =
  /(?:^|\/)(?:plans|ai_docs|\.?orchestrate)\/[^\n]*\.md$|(?:^|\/)(?:plan|phase-\d+|plan-verdict|result-verdict)[-_a-z0-9]*\.md$/i;

export const PLAN_PREP_CMD_RE =
  /(?:\bmkdir\b[^\n]*\b(?:plans|ai_docs|\.mekong|\.orchestrate)\b|\b(?:ak|mk)\s+plan\b|set-active-plan\.cjs)/i;

// Code review, Security Vulnerability Audit & Sun Tzu / Supervisor detection
export const CODE_REVIEW_SYSTEM_RE =
  /(?:performing production-readiness review|Staff Engineer[\s\S]{0,80}review|You are Sun Tzu|evaluator and supervisor|subagent_type["']?\s*:\s*["']?(?:code-reviewer|suntzu|kongming|advisor|code-simplifier))/i;

export const CODE_REVIEW_PROMPT_RE =
  /(?:^\s*Perform a (?:mandatory\s+)?code review\b|^\s*Review this change for security vulnerabilities\b|You previously flagged these candidate vulnerabilities|^\s*Review the (?:newly implemented|following|recent|updated|uncommitted) (?:code|changes|modules|files|pilot)\b|^\s*Re-verify the \d+ files\b|^\s*Validate all \d+ tasks\b|^\s*Verify and synchronize the Company Blueprint\b|Giám sát kết quả tại \.orchestrate|<command-name>\/?(?:ak[-:]review|ak[-:]code-review|mk[-:]code-review|review|code-review|cto)<\/command-name>|\/(?:ak[-:]review|ak[-:]code-review|mk[-:]code-review|review|code-review)\b|(?:kiểm tra lại|review lại|rà soát lại|audit lại)\s+(?:kết quả\s+)?code\b)/i;

// Research, Scouting & QA Testing subagent / workflow detection
export const RESEARCH_QA_SYSTEM_RE =
  /(?:You are a \*?\*?QA Lead|subagent_type["']?\s*:\s*["']?(?:researcher|scout|explore|tester))/i;

export const RESEARCH_QA_PROMPT_RE =
  /(?:<command-name>\/?(?:ak[-:]research|ak[-:]autoresearch|mk[-:]research|research|scout)<\/command-name>|(?:^|[\s"'`“‘(>:])\/(?:ak[-:]research|ak[-:]autoresearch|mk[-:]research|research|scout)\b|^\s*(?:Conduct technical research|Research Tasks?\b|Execute Phase \d+[^\n]*tests\b))/i;

// Bug Fix & Code Review Fix session detection
export const FIX_DEBUG_SYSTEM_RE =
  /(?:Root Cause Analyst|subagent_type["']?\s*:\s*["']?debugger)/i;

export const FIX_DEBUG_PROMPT_RE =
  /(?:<command-name>\/?(?:ak[-:]fix|mk[-:]fix|fix|debug)<\/command-name>|(?:^|[\s"'`“‘(>:])\/(?:ak[-:]fix|mk[-:]fix|fix|debug)\b|^\s*Fix all \d+ findings from the Code Review\b)/i;

// UI/UX Design & Stitch Loop session detection
export const STITCH_DESIGN_SYSTEM_RE =
  /(?:elite UI\/UX Designer|Awwwards, Mobbin|subagent_type["']?\s*:\s*["']?(?:ui-ux-designer|designer))/i;

export const STITCH_DESIGN_PROMPT_RE =
  /(?:<command-name>\/?(?:stitch[-:]loop|stitch[-:]ideate|stitch|ui[-:]ux[-:]pro[-:]max|frontend[-:]design)<\/command-name>|(?:^|[\s"'`“‘(>:])\/(?:stitch[-:]loop|stitch[-:]ideate|stitch|ui[-:]ux[-:]pro[-:]max|frontend[-:]design)\b|skills\/(?:stitch[-:]loop|stitch[-:]ideate|ui[-:]ux[-:]pro[-:]max|frontend[-:]design)\b|github\.com\/gabelul\/stitch-kit\b)/i;

export const STITCH_DESIGN_FILE_PATH_RE =
  /(?:^|\/)(?:DESIGN|SITE|next-prompt)\.md$|(?:^|\/)stitch\.json$|(?:^|\/)\.stitch\/[^\n]+$/i;

// Tool call retry / output token resume escalation
export const TOOL_RETRY_ESCALATION_RE =
  /(?:The previous response failed to produce a valid tool call\. Please retry the tool call now|Output token limit hit\. Resume directly)/i;

// Commands executed right after Write/Edit to verify the code that Gemini 3.8 just wrote
export const POST_CODING_VERIFY_CMD_RE =
  /\b(?:pytest|vitest|bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|cargo\s+test|go\s+test|mypy|pyright|tsc\b|ruff\s+check|eslint|biome\s+check|npm\s+run\s+(?:build|typecheck|lint|check)|pnpm\s+(?:run\s+)?(?:build|typecheck|lint|check)|git\s+(?:diff|status)\b|wc\s+-l\b|plan\s+validate|opencore-saas\s+audit)\b/i;

export const SUBAGENT_REVIEW_NOTIFICATION_RE =
  /<task-notification>[\s\S]*?(?:Review Complete|Code Review Summary|All tests passed|production-readiness review|Commit security review|security review found)/i;

// Deep reasoning, System Architecture & Planning Kickoff regex
// Reserved strictly for true deep planning / architectural design to prevent burning Gemini 4 Argon High on routine tasks.
export const HEAVY_TASK_RE =
  /(?:\/(?:plan|idea|advise)\b|\/(?:ak|mk)[-:](?:advise|bootstrap|brainstorm|plan|strategist|architect)\b|<command-name>\/?(?:ak|mk)[-:](?:advise|bootstrap|brainstorm|plan|strategist|architect)<\/command-name>|\b(?:system architecture|architectural blueprint|high[- ]level architecture|deep architectural planning|deep[- ]?planning|enterprise architecture)\b|(?:kiến trúc hệ thống|thiết kế kiến trúc tổng thể|hoạch định kiến trúc|kế hoạch kiến trúc))/i;

export const CRITICAL_TASK_RE =
  /\b(zero[- ]day|exploit|rce|remote code execution|account takeover|auth bypass|privilege escalation|sandbox escape|deserialization|prod incident|data exfiltration|bug bounty)\b/i;

// Code & Engineering safety regex: protects codebase integrity from low-capability models
export const CODING_TASK_RE =
  /\b(code|coding|function|class|method|struct|interface|refactor|debug|bug|fix|patch|error|exception|test|unittest|git|diff|commit|pr|pull request|endpoint|api|schema|migration|database|query|sql|typescript|javascript|python|golang|rust|cpp|react|node|html|css|file|directory|path|syntax|type|ast|lint|build|compile|deploy|repo|repository|terminal|bash|exec|curl|import|export|return)\b/i;

export const EXACT_ARCHITECTURE_SIGNALS_RE =
  /(?:system\s*design|architecture|architectur|framework\s*migrat|migration[- ]explicit|large[- ]refactor|trade[- ]?off|tradeoff|complexity\s+analysis)/i;

export const STRONG_ARCHITECTURE_SIGNALS_RE =
  /(?:multi[- ]?file\s+(?:refactor|change|edit)|optimization\s+strateg|migration\s+plan|data\s+model|schema\s+(?:design|change|migrat)|api\s+(?:design|architect)|performance\s+(?:optim|analyz|tun|bottleneck|improv)|security\s+(?:audit|review|analyz)|database\s+(?:schema|migrat|design))/i;


// ── Conversation affinity state ───────────────────────────────────────────────

/** @internal exported only for testing */
export const comboConversationAffinity = new Map<string, { index: number; lastUsed: number }>();
const CONVERSATION_AFFINITY_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONVERSATION_AFFINITY_ENTRIES = 1000;

// ── Strategy gate ─────────────────────────────────────────────────────────────

export function isTaskRoutingStrategy(strategy: unknown): boolean {
  return ["smart", "task", "task-aware", "task_aware"].includes(
    String(strategy ?? "").toLowerCase()
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function taskWeight(level: TaskLevel): number {
  return TASK_LEVEL_WEIGHT[level];
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (typeof value !== "object") return out;

  const rec = value as Record<string, unknown>;
  if (typeof rec["text"] === "string") out.push(rec["text"]);
  if (typeof rec["input_text"] === "string") out.push(rec["input_text"]);
  if (typeof rec["output_text"] === "string") out.push(rec["output_text"]);
  if (typeof rec["content"] === "string") out.push(rec["content"]);
  else if (Array.isArray(rec["content"])) collectText(rec["content"], out);
  if (Array.isArray(rec["parts"])) collectText(rec["parts"], out);
  if (typeof rec["query"] === "string") out.push(rec["query"]);
  if (typeof rec["url"] === "string") out.push(rec["url"]);

  return out;
}

function estimatePromptChars(body: Record<string, unknown>): number {
  const contents =
    (body["contents"] as unknown) ??
    ((body["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown);
  const parts = [
    body["system"],
    body["instructions"],
    body["messages"],
    body["input"],
    contents,
    body["query"],
    body["url"],
  ];
  return collectText(parts).join("\n").length;
}

function countMessages(body: Record<string, unknown>): number {
  const contents =
    (body["contents"] as unknown[]) ??
    ((body["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown[]);
  return (
    (Array.isArray(body["messages"]) ? body["messages"].length : 0) +
    (Array.isArray(body["input"]) ? body["input"].length : 0) +
    (Array.isArray(body["contents"]) ? (body["contents"] as unknown[]).length : 0) +
    (Array.isArray(contents) ? contents.length : 0)
  );
}

function maxRequestedOutput(body: Record<string, unknown>): number {
  const genConf = body["generationConfig"] as Record<string, unknown> | undefined;
  const candidates = [
    body["max_tokens"],
    body["max_output_tokens"],
    body["max_completion_tokens"],
    genConf?.["maxOutputTokens"],
  ]
    .map((v) => Number.parseInt(String(v ?? ""), 10))
    .filter((v) => Number.isFinite(v));
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function getTaskText(body: Record<string, unknown>): string {
  const contents =
    (body?.["contents"] as unknown) ??
    ((body?.["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown);
  return collectText([
    body?.["system"],
    body?.["instructions"],
    body?.["messages"],
    body?.["input"],
    contents,
    body?.["query"],
    body?.["url"],
  ]).join("\n");
}

function stripInjectedReminders(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, "")
    .replace(/^Contents of [^\n]+CLAUDE\.md:[\s\S]*$/gim, "")
    .trim();
  if (/^Base directory for this skill:/i.test(stripped)) {
    const firstLine = stripped.split(/\r?\n/)[0] ?? stripped.slice(0, 160);
    const argsMatch = stripped.match(/(?:^|\n)\s*ARGUMENTS:\s*[\s\S]*$/i);
    return argsMatch ? `${firstLine}\n${argsMatch[0].trim()}` : firstLine;
  }
  return stripped;
}

function isToolContinuationTurn(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  // Walk backwards skipping trailing system/developer messages and pure <system-reminder> user attachments
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    const role = String(m["role"] ?? "");
    if (role === "system" || role === "developer") continue;
    if (role === "tool" || role === "function") return true;
    if (role === "user") {
      if (isUserToolResultMessage(m)) return true;
      if (extractUserMessageNonToolText(m).length === 0) continue;
      return false;
    }
    break;
  }
  const input = Array.isArray(body?.["input"]) ? (body["input"] as unknown[]) : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;
    if (item["role"] === "system" || item["role"] === "developer") continue;
    if (item["type"] === "function_call_output") return true;
    break;
  }
  return false;
}

const TOOL_ERROR_TEXT_RE =
  /(?:Traceback \(most recent call last\)|\b(?:AssertionError|SyntaxError|ReferenceError|TypeError):|\berror TS\d+:|\bFAIL(?:ED)?\b.*(?:test|spec|\.py|\.ts)|panic: runtime error)/i;

function hasLatestToolResultError(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    const role = String(m["role"] ?? "");
    if (role === "system" || role === "developer") continue;
    if (role === "user" && Array.isArray(m["content"])) {
      const blocks = m["content"] as Array<Record<string, unknown>>;
      for (const b of blocks) {
        if (!b || typeof b !== "object" || b["type"] !== "tool_result") continue;
        const txt = collectText(b["content"]).join("\n");
        if (TOOL_ERROR_TEXT_RE.test(txt)) return true;
      }
    }
    break;
  }
  return false;
}

function extractUserMessageNonToolText(m: Record<string, unknown>): string {
  if (Array.isArray(m["content"])) {
    const blocks = m["content"] as Array<Record<string, unknown>>;
    const hasToolResult = blocks.some((b) => b && typeof b === "object" && b["type"] === "tool_result");
    const textBlocks = blocks
      .filter((b) => b && typeof b === "object" && b["type"] !== "tool_result")
      .map((b) => stripInjectedReminders(collectText(b).join(" ")))
      .filter((t) => t.length > 0)
      .join(" ")
      .trim();
    if (hasToolResult && textBlocks.length === 0) return "";
    return textBlocks;
  }
  return stripInjectedReminders(collectText(m["content"] ?? m["parts"]).join(" ")).trim();
}

function isUserToolResultMessage(m: Record<string, unknown>): boolean {
  if (m["role"] !== "user" || !Array.isArray(m["content"])) return false;
  const hasToolResult = (m["content"] as Array<Record<string, unknown>>).some(
    (b) => b && typeof b === "object" && b["type"] === "tool_result"
  );
  if (!hasToolResult) return false;
  // When Claude Code merges a dangling tool_result (e.g. after an aborted/<synthetic> turn)
  // with a new human prompt/command in the same user message, treat it as a user prompt turn!
  const nonToolText = extractUserMessageNonToolText(m);
  if (
    nonToolText.length > 0 &&
    !/^The previous response failed to produce a valid tool call/i.test(nonToolText) &&
    !/^CRITICAL:\s*Respond with TEXT ONLY/i.test(nonToolText) &&
    !/^Output token limit hit/i.test(nonToolText)
  ) {
    return false;
  }
  return true;
}

/**
 * Extract the text of the latest human turn.
 * Note: When Claude Code expands a skill/slash command (like `/ak-bootstrap ...`),
 * it emits TWO consecutive `role: "user"` messages:
 *   1) `<command-message>ak-bootstrap</command-message><command-name>/ak-bootstrap</command-name><command-args>...</command-args>`
 *   2) `Base directory for this skill: ...`
 * Walking backwards and joining contiguous non-tool_result `role: "user"` messages preserves both!
 */
function extractLastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m["role"] !== "user") continue;
    if (isUserToolResultMessage(m)) continue;
    const text = extractUserMessageNonToolText(m);
    if (!text) continue;
    const chunks: string[] = [text];
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j] as Record<string, unknown> | undefined;
      if (!prev || typeof prev !== "object") continue;
      const prevRole = String(prev["role"] ?? "");
      if (prevRole === "system" || prevRole === "developer") continue;
      if (prevRole !== "user" || isUserToolResultMessage(prev)) break;
      const prevText = extractUserMessageNonToolText(prev);
      if (prevText) chunks.unshift(prevText);
    }
    return chunks.join("\n");
  }
  if (typeof body?.["input"] === "string") return stripInjectedReminders(body["input"]);
  if (Array.isArray(body?.["input"])) {
    for (let i = (body["input"] as unknown[]).length - 1; i >= 0; i--) {
      const item = (body["input"] as unknown[])[i] as Record<string, unknown> | undefined;
      if (item && typeof item === "object" && item["role"] === "user") {
        const cleaned = stripInjectedReminders(collectText(item["content"]).join(" "));
        if (cleaned.length > 0) return cleaned;
      }
    }
  }
  if (typeof body?.["query"] === "string") return stripInjectedReminders(body["query"]);
  return "";
}

interface WorkflowKickoffState {
  isKickoffCommand: boolean;
  isSessionContinuation: boolean;
  toolRoundtripsSincePrompt: number;
  hasHandedOffToExecution: boolean;
  isIdeaPhaseTurn: boolean;
  isPlanningPhaseTurn: boolean;
  isCodeReviewerSession: boolean;
  isCodeReviewerSynthesisTurn: boolean;
  isPostCodingVerificationTurn: boolean;
  isResearchOrQaTurn: boolean;
  isFixOrDebugTurn: boolean;
  isStitchDesignTurn: boolean;
  isPhaseSpecOrNewModuleTurn: boolean;
  isToolRetryEscalationTurn: boolean;
  isCompactionReorientTurn: boolean;
}

function getSystemAndInstructionsText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  const sysMsgs = messages
    .filter(
      (m): m is Record<string, unknown> =>
        !!m &&
        typeof m === "object" &&
        (m["role"] === "system" || m["role"] === "developer")
    )
    .map((m) => collectText(m["content"]).join("\n"));
  return [
    collectText(body?.["system"]).join("\n"),
    collectText(body?.["instructions"]).join("\n"),
    ...sysMsgs,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Inspect the current conversation to manage the Balanced Ultra Frontier Sandwich lifecycle:
 * - Balances the 3 Google AI Ultra accounts (`antigravity/gemini-4-argon-high`) and Workhorse pool
 *   (`antigravity/gemini-3.8-flash-tiered`) at ~60-65% Gemini 4 / ~35-40% Gemini 3.8.
 */
function getWorkflowKickoffState(body: Record<string, unknown>): WorkflowKickoffState {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  let toolRoundtripsSincePrompt = 0;
  let hasMutatedOrAskedQuestion = false;
  let originatingUserText = "";
  let promptIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    const role = String(m["role"] ?? "");
    if (role === "system" || role === "developer") continue;

    if (role === "tool" || role === "function" || isUserToolResultMessage(m)) {
      toolRoundtripsSincePrompt++;
      continue;
    }

    if (role === "assistant") {
      const content = Array.isArray(m["content"]) ? (m["content"] as Array<Record<string, unknown>>) : [];
      for (const b of content) {
        if (!b || typeof b !== "object" || b["type"] !== "tool_use") continue;
        const toolName = String(b["name"] ?? "");
        if (/^(Write|Edit|MultiEdit|NotebookEdit|AskUserQuestion)$/i.test(toolName)) {
          hasMutatedOrAskedQuestion = true;
        }
      }
      continue;
    }

    if (role === "user") {
      const text = extractUserMessageNonToolText(m);
      if (!text) continue;
      const chunks: string[] = [text];
      promptIndex = i;
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j] as Record<string, unknown> | undefined;
        if (!prev || typeof prev !== "object") continue;
        const prevRole = String(prev["role"] ?? "");
        if (prevRole === "system" || prevRole === "developer") continue;
        if (prevRole !== "user" || isUserToolResultMessage(prev)) break;
        const prevText = extractUserMessageNonToolText(prev);
        if (prevText) {
          chunks.unshift(prevText);
          promptIndex = j;
        }
      }
      originatingUserText = chunks.join("\n");
      break;
    }
  }

  if (!originatingUserText) {
    originatingUserText = extractLastUserText(body);
  }

  // Also check if an earlier user message in this conversation started a workflow
  let workflowStartIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m["role"] !== "user" || isUserToolResultMessage(m)) continue;
    const txt = extractUserMessageNonToolText(m);
    if (txt && !SESSION_CONTINUATION_RE.test(txt) && WORKFLOW_KICKOFF_RE.test(txt)) {
      workflowStartIdx = i;
      break;
    }
  }

  const isSessionContinuation = SESSION_CONTINUATION_RE.test(originatingUserText);
  const sysText = getSystemAndInstructionsText(body);

  const isIdeaSession =
    IDEA_SYSTEM_RE.test(sysText) || (!isSessionContinuation && IDEA_PROMPT_RE.test(originatingUserText));
  const isBootstrapSession =
    !isSessionContinuation &&
    /\/(?:ak|mk)[-:]bootstrap\b|<command-name>\/?(?:ak|mk)[-:]bootstrap<\/command-name>/i.test(
      originatingUserText
    );
  const isDedicatedIdeaSession = isIdeaSession && !isBootstrapSession;

  const isPlannerSession =
    PLANNER_SYSTEM_RE.test(sysText) || (!isSessionContinuation && PLANNER_PROMPT_RE.test(originatingUserText));
  const isCodeReviewerSession =
    CODE_REVIEW_SYSTEM_RE.test(sysText) ||
    (!isSessionContinuation && CODE_REVIEW_PROMPT_RE.test(originatingUserText));
  const isResearchOrQaSession =
    RESEARCH_QA_SYSTEM_RE.test(sysText) ||
    (!isSessionContinuation && RESEARCH_QA_PROMPT_RE.test(originatingUserText));
  const isFixDebugSession =
    FIX_DEBUG_SYSTEM_RE.test(sysText) ||
    (!isSessionContinuation && FIX_DEBUG_PROMPT_RE.test(originatingUserText));
  const isStitchDesignSession =
    STITCH_DESIGN_SYSTEM_RE.test(sysText) ||
    (!isSessionContinuation && STITCH_DESIGN_PROMPT_RE.test(originatingUserText));
  const isToolRetryEscalation = TOOL_RETRY_ESCALATION_RE.test(originatingUserText);

  const isCurrentPromptNewCommand =
    isIdeaSession ||
    isPlannerSession ||
    isCodeReviewerSession ||
    isResearchOrQaSession ||
    isFixDebugSession ||
    isStitchDesignSession ||
    (!isSessionContinuation && WORKFLOW_KICKOFF_RE.test(originatingUserText));

  // Scan from workflowStartIdx (or promptIndex if the current prompt started a brand-new command)
  let hasWrittenPlanFileInWorkflow = false;
  let hasSeenSourceCodeEdit = false;
  let verifyTurnsSinceLastEdit = 0;
  let lastAssistantWasVerify = false;
  let lastAssistantWasIdeaAction = false;
  let lastAssistantWasPlanAction = false;
  let lastAssistantAskedPlanApproval = false;
  let lastAssistantInReviewerIsInspection = false;
  let lastAssistantWasStitchAction = false;
  let lastAssistantWasFixMutation = false;
  let lastAssistantReadPlanOrSpec = false;
  let lastAssistantWroteNewFile = false;

  const scanFromIdx =
    isCurrentPromptNewCommand && promptIndex >= 0
      ? promptIndex
      : workflowStartIdx >= 0
      ? workflowStartIdx
      : promptIndex >= 0
      ? promptIndex
      : 0;

  for (let i = scanFromIdx; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m["role"] !== "assistant") continue;
    const content = Array.isArray(m["content"]) ? (m["content"] as Array<Record<string, unknown>>) : [];
    const toolUses = content.filter((b) => b && typeof b === "object" && b["type"] === "tool_use");
    if (toolUses.length === 0) continue;

    let turnHasSourceEdit = false;
    let turnHasIdeaAction = false;
    let turnHasPlanAction = false;
    let turnAskedPlanApproval = false;
    let turnHasStitchAction = false;
    let turnHasFixMutation = false;
    let turnReadPlanOrSpec = false;
    let turnWroteNewFile = false;

    for (const b of toolUses) {
      const name = String(b["name"] ?? "");
      const input = (b["input"] as Record<string, unknown> | undefined) ?? {};

      if (/^mcp__stitch__/i.test(name)) {
        turnHasStitchAction = true;
      }

      if (/^Read$/i.test(name)) {
        const fp = String(input["file_path"] ?? input["path"] ?? "");
        if (PLAN_FILE_PATH_RE.test(fp) || IDEA_FILE_PATH_RE.test(fp) || STITCH_DESIGN_FILE_PATH_RE.test(fp)) {
          turnReadPlanOrSpec = true;
        }
        if (STITCH_DESIGN_FILE_PATH_RE.test(fp)) {
          turnHasStitchAction = true;
        }
      } else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
        const fp = String(input["file_path"] ?? input["path"] ?? "");
        if (
          IDEA_FILE_PATH_RE.test(fp) ||
          (isIdeaSession && /(?:^|\/)(?:docs\/[^\n]*\.md|README\.md)$/i.test(fp))
        ) {
          turnHasIdeaAction = true;
        } else if (PLAN_FILE_PATH_RE.test(fp)) {
          turnHasPlanAction = true;
          if (!/brainstorm/i.test(fp)) {
            hasWrittenPlanFileInWorkflow = true;
          }
        } else if (STITCH_DESIGN_FILE_PATH_RE.test(fp)) {
          turnHasStitchAction = true;
        } else {
          turnHasSourceEdit = true;
          if (/^Write$/i.test(name)) {
            turnWroteNewFile = true;
          }
          if (isFixDebugSession) {
            turnHasFixMutation = true;
          }
          if (isStitchDesignSession && /^Write$/i.test(name)) {
            turnHasStitchAction = true;
          }
        }
      } else if (/^Skill$/i.test(name)) {
        const sk = String(input["skill"] ?? "");
        if (/^(?:idea|mk[-:]idea|ak[-:]idea)$/i.test(sk)) {
          turnHasIdeaAction = true;
        } else if (/^(?:ak[-:]plan|mk[-:]plan|plan|ak[-:]brainstorm)$/i.test(sk)) {
          turnHasPlanAction = true;
        } else if (/^(?:stitch[-:]loop|stitch[-:]ideate|stitch|ui[-:]ux[-:]pro[-:]max|frontend[-:]design)$/i.test(sk)) {
          turnHasStitchAction = true;
        }
      } else if (/^(Agent|Task)$/i.test(name)) {
        const sub = String(input["subagent_type"] ?? "");
        const prompt = String(input["prompt"] ?? "");
        const desc = String(input["description"] ?? "");
        if (
          /^(?:idea|bizplan)$/i.test(sub) ||
          IDEA_PROMPT_RE.test(prompt) ||
          IDEA_PROMPT_RE.test(desc)
        ) {
          turnHasIdeaAction = true;
        } else if (/^planner$/i.test(sub)) {
          turnHasPlanAction = true;
        } else if (/^(?:ui-ux-designer|designer)$/i.test(sub) || isStitchDesignSession) {
          turnHasStitchAction = true;
        }
      } else if (/^Bash$/i.test(name)) {
        const cmd = String(input["command"] ?? "");
        if (PLAN_PREP_CMD_RE.test(cmd)) {
          if (/\bmkdir\b/i.test(cmd)) {
            if (/\.mekong|company-blueprint/i.test(cmd)) {
              turnHasIdeaAction = true;
            } else {
              turnHasPlanAction = true;
            }
          }
        }
      } else if (/^AskUserQuestion$/i.test(name)) {
        const qText = JSON.stringify(input);
        if (/ak[-:]plan|kế\s+hoạch|\bplan\b/i.test(qText)) {
          turnAskedPlanApproval = true;
        }
        if (isStitchDesignSession) {
          turnHasStitchAction = true;
        }
      }
    }

    lastAssistantWasIdeaAction = turnHasIdeaAction;
    lastAssistantWasPlanAction = turnHasPlanAction;
    lastAssistantAskedPlanApproval = turnAskedPlanApproval;
    lastAssistantWasStitchAction = turnHasStitchAction;
    lastAssistantWasFixMutation = turnHasFixMutation;
    lastAssistantReadPlanOrSpec = turnReadPlanOrSpec;
    lastAssistantWroteNewFile = turnWroteNewFile;

    if (turnHasSourceEdit) {
      hasSeenSourceCodeEdit = true;
      verifyTurnsSinceLastEdit = 0;
      lastAssistantWasVerify = false;
      continue;
    }

    const hasVerifyTool = toolUses.some((b) => {
      const name = String(b["name"] ?? "");
      const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
      if (/^Bash$/i.test(name)) {
        const cmd = String(input["command"] ?? "");
        return POST_CODING_VERIFY_CMD_RE.test(cmd);
      }
      if (/^(Agent|Task)$/i.test(name)) {
        const subType = String(input["subagent_type"] ?? "");
        const prompt = String(input["prompt"] ?? "");
        return /code-reviewer|tester|review|suntzu/i.test(subType) || /code review|security vulnerabilities/i.test(prompt);
      }
      return false;
    });

    if (hasSeenSourceCodeEdit && hasVerifyTool) {
      verifyTurnsSinceLastEdit++;
      lastAssistantWasVerify = true;
    } else {
      lastAssistantWasVerify = false;
    }

    if (isCodeReviewerSession) {
      lastAssistantInReviewerIsInspection = toolUses.some((b) => {
        const name = String(b["name"] ?? "");
        const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
        if (/^(Read|Grep|Glob)$/i.test(name)) return true;
        if (/^Bash$/i.test(name)) {
          const cmd = String(input["command"] ?? "");
          if (/^\s*(?:find|ls|wc)\b/i.test(cmd) && !POST_CODING_VERIFY_CMD_RE.test(cmd)) return false;
          return POST_CODING_VERIFY_CMD_RE.test(cmd) || /\b(?:python3?|node|bun|git\s+diff|git\s+log|grep)\b/i.test(cmd);
        }
        return false;
      });
    }
  }

  // Check if the latest user message is a `<task-notification>` from a completed code/security review or /idea subagent
  let hasSubagentReviewNotification = false;
  let hasSubagentIdeaNotification = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    const role = String(m["role"] ?? "");
    if (role === "system" || role === "developer") continue;
    if (role === "user") {
      const rawUserContent = collectText(m["content"]).join("\n");
      if (SUBAGENT_REVIEW_NOTIFICATION_RE.test(rawUserContent)) {
        hasSubagentReviewNotification = true;
      }
      if (SUBAGENT_IDEA_NOTIFICATION_RE.test(rawUserContent)) {
        hasSubagentIdeaNotification = true;
      }
      if (rawUserContent.trim().length > 0 && !/^<system-reminder>/i.test(rawUserContent.trim())) {
        break;
      }
      continue;
    }
    break;
  }

  const isPhaseOrCookExecution =
    !isSessionContinuation &&
    /(?:^\s*Execute Phase \d+\b|<command-name>\/?(?:ak[-:]cook|mk[-:]cook|cook|orchestrate)<\/command-name>|\/(?:ak[-:]cook|mk[-:]cook|cook|orchestrate)\b|Tiếp tục hoàn tất phần còn lại của kế hoạch tại \.orchestrate)/i.test(
      originatingUserText
    );
  const isKickoffCommand =
    !isSessionContinuation &&
    (WORKFLOW_KICKOFF_RE.test(originatingUserText) || isPhaseOrCookExecution);
  const maxKickoffRoundtrips = isPhaseOrCookExecution ? 5 : 3;
  const hasHandedOffToExecution =
    toolRoundtripsSincePrompt > maxKickoffRoundtrips || hasSeenSourceCodeEdit || hasMutatedOrAskedQuestion;

  const isIdeaPhaseTurn =
    !isSessionContinuation &&
    !hasSeenSourceCodeEdit &&
    (isDedicatedIdeaSession || lastAssistantWasIdeaAction || hasSubagentIdeaNotification);

  const isUserBrainstormApprovalForPlan =
    workflowStartIdx >= 0 &&
    !hasSeenSourceCodeEdit &&
    ((promptIndex > workflowStartIdx && toolRoundtripsSincePrompt === 0 && !hasWrittenPlanFileInWorkflow) ||
      (toolRoundtripsSincePrompt === 1 && lastAssistantAskedPlanApproval));

  const isPlanningPhaseTurn =
    !isSessionContinuation &&
    !hasSeenSourceCodeEdit &&
    ((isPlannerSession && toolRoundtripsSincePrompt <= 3) || lastAssistantWasPlanAction || isUserBrainstormApprovalForPlan);

  const isPostCodingVerificationTurn =
    hasSubagentReviewNotification ||
    (hasSeenSourceCodeEdit &&
      lastAssistantWasVerify &&
      verifyTurnsSinceLastEdit >= 1 &&
      verifyTurnsSinceLastEdit <= 3);

  const isCodeReviewerSynthesisTurn =
    isCodeReviewerSession &&
    toolRoundtripsSincePrompt <= 3;

  const isResearchOrQaTurn =
    !isSessionContinuation && !hasSeenSourceCodeEdit && isResearchOrQaSession && toolRoundtripsSincePrompt <= 3;

  const isFixOrDebugTurn =
    isFixDebugSession &&
    (toolRoundtripsSincePrompt <= 3 ||
      lastAssistantWasFixMutation ||
      lastAssistantWasVerify);

  const isStitchDesignTurn =
    (isStitchDesignSession && (toolRoundtripsSincePrompt <= 3 || lastAssistantWasStitchAction)) ||
    (!isStitchDesignSession && lastAssistantWasStitchAction);

  const isPhaseSpecOrNewModuleTurn =
    lastAssistantReadPlanOrSpec || lastAssistantWroteNewFile;

  const isToolRetryEscalationTurn =
    isToolRetryEscalation && toolRoundtripsSincePrompt <= 1;

  const isCompactionReorientTurn =
    isSessionContinuation && toolRoundtripsSincePrompt <= 1;

  return {
    isKickoffCommand,
    isSessionContinuation,
    toolRoundtripsSincePrompt,
    hasHandedOffToExecution,
    isIdeaPhaseTurn,
    isPlanningPhaseTurn,
    isCodeReviewerSession,
    isCodeReviewerSynthesisTurn,
    isPostCodingVerificationTurn,
    isResearchOrQaTurn,
    isFixOrDebugTurn,
    isStitchDesignTurn,
    isPhaseSpecOrNewModuleTurn,
    isToolRetryEscalationTurn,
    isCompactionReorientTurn,
  };
}

function countExecutedToolTurns(body: Record<string, unknown>): number {
  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  let count = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec["role"] === "tool") {
      count++;
    } else if (rec["role"] === "user" && Array.isArray(rec["content"])) {
      if ((rec["content"] as Array<Record<string, unknown>>).some((c) => c && typeof c === "object" && c["type"] === "tool_result")) count++;
    } else if (rec["role"] === "assistant") {
      if (Array.isArray(rec["tool_calls"]) && (rec["tool_calls"] as unknown[]).length > 0) count++;
      if (Array.isArray(rec["content"]) && (rec["content"] as Array<Record<string, unknown>>).some((c) => c && typeof c === "object" && c["type"] === "tool_use")) count++;
    }
  }
  return count;
}

function normalizeEffort(body: Record<string, unknown>): string {
  const reasoning = body?.["reasoning"] as Record<string, unknown> | undefined;
  return String(body?.["reasoning_effort"] ?? reasoning?.["effort"] ?? "").toLowerCase();
}

// ── Task signals ──────────────────────────────────────────────────────────────

export interface TaskSignals {
  promptChars: number;
  messageCount: number;
  toolCount: number;
  outputTokens: number;
  effort: string;
  hasExplicitReasoning: boolean;
  lightKeyword: boolean;
  heavyKeyword: boolean;
  criticalKeyword: boolean;
  codingKeyword: boolean;
  requestedModel: string;
}

export function getTaskSignals(body: Record<string, unknown>): TaskSignals {
  const promptChars = estimatePromptChars(body);
  const messageCount = countMessages(body);
  const toolCount = Array.isArray(body?.["tools"]) ? (body["tools"] as unknown[]).length : 0;
  const outputTokens = maxRequestedOutput(body);
  const effort = normalizeEffort(body);
  const lastUserText = extractLastUserText(body);

  const requestedModel = String((body as Record<string, unknown> | undefined)?.["model"] ?? "").toLowerCase();
  return {
    promptChars,
    messageCount,
    toolCount,
    outputTokens,
    effort,
    hasExplicitReasoning: Boolean(
      effort && effort !== "none" && effort !== "off" && effort !== "disabled"
    ),
    lightKeyword: LIGHT_TASK_RE.test(lastUserText),
    heavyKeyword: HEAVY_TASK_RE.test(lastUserText),
    criticalKeyword: CRITICAL_TASK_RE.test(lastUserText),
    codingKeyword: CODING_TASK_RE.test(lastUserText),
    requestedModel,
  };
}

// ── Task classification ───────────────────────────────────────────────────────

export interface TaskClassification extends TaskSignals {
  level: TaskLevel;
  weight: number;
  reasons: string[];
}

/**
 * Classify request difficulty for smart combo routing.
 *
 * Distinguishes between light/auxiliary, standard routine coding (including intermediate
 * tool-loop continuation turns), heavy engineering, and critical reasoning tasks without
 * burning frontier quota on boilerplate system prompts or micro tool steps.
 */
export type ActiveCommandMode = "advise" | "vibe" | null;

/**
 * Detect whether the conversation is currently inside an active `/ak-advise`
 * (consulting -> Gemini 4 Argon High) or `/ak-vibe` / `/ak-vide` (pure coding -> Gemini 3.8 Flash)
 * workflow.
 */
export function detectActiveCommandMode(body: Record<string, unknown>): ActiveCommandMode {
  // Check system prompt ONLY if it explicitly declares an advisor subagent.
  // Never match generic skill catalog descriptions or compacted history headers.
  const sysOnly = collectText(body?.["system"]).join("\n");
  if (/subagent_type["']?\s*:\s*["']?(?:advisor|kongming|suntzu)\b/i.test(sysOnly)) {
    return "advise";
  }
  if (
    /^\s*Act as the user's most trusted technical advisor\b/i.test(sysOnly) &&
    !/(?:###\s*Skill:|Base directory for this skill:|userSettings:)/i.test(sysOnly)
  ) {
    return "advise";
  }

  const messages = Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]) : [];
  let activeMode: ActiveCommandMode = null;
  let activeCmdIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m["role"] !== "user") continue;

    const blocks = Array.isArray(m["content"])
      ? (m["content"] as Array<Record<string, unknown>>)
      : [{ type: "text", text: String(m["content"] ?? "") }];

    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b["type"] === "tool_result") {
        const toolTxt = collectText(b).join(" ");
        if (/^name:\s*ak-advise\b/im.test(toolTxt)) {
          activeMode = "advise";
          activeCmdIdx = i;
        }
        continue;
      }

      const rawText = collectText(b).join(" ");
      const cleaned = stripInjectedReminders(rawText);
      if (!cleaned) continue;

      // Ignore skill catalog or compacted skill listings
      if (/(?:###\s*Skill:\s*(?:ak|mk)[-:]|Base directory for this skill:)/i.test(cleaned)) {
        continue;
      }

      const hasExplicitTag = /<command-name>|<command-message>/i.test(cleaned);
      if (VIBE_COMMAND_RE.test(cleaned)) {
        activeMode = "vibe";
        activeCmdIdx = i;
      } else if (ADVISE_COMMAND_RE.test(cleaned)) {
        activeMode = "advise";
        activeCmdIdx = i;
      } else if (hasExplicitTag) {
        const tagMatch = cleaned.match(/<command-name>\/?([^<]+)<\/command-name>/i);
        const cmdName = (tagMatch?.[1] ?? "").trim().toLowerCase();
        if (cmdName && !/^(?:clear|compact|login|status|help|model|cost|doctor|memory|config)$/i.test(cmdName)) {
          activeMode = null;
          activeCmdIdx = i;
        }
      }
    }
  }

  if (activeMode === "advise" && activeCmdIdx >= 0) {
    // 1. Release advise mode if conversation was compacted or restarted after the command was issued
    for (let i = activeCmdIdx + 1; i < messages.length; i++) {
      const m = messages[i] as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object") continue;
      const text = JSON.stringify(m["content"] ?? "");
      if (/Context was compacted|Session compact|This session is being continued from a previous conversation/i.test(text)) {
        return null;
      }
    }

    // 2. Track assistant delivery of final advisory report/response
    let deliveredAdvisoryReport = false;
    let deliveredReportIdx = -1;

    for (let i = activeCmdIdx + 1; i < messages.length; i++) {
      const m = messages[i] as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object") continue;
      const role = String(m["role"] ?? "");

      // If user invoked another explicit workflow command (e.g. /ak-cook, /ak-vibe, /ak-fix)
      if (role === "user" && !isUserToolResultMessage(m)) {
        const uText = extractUserMessageNonToolText(m);
        if (
          /<command-message>\s*(?:ak-cook|ak-vibe|ak-vide|ak-fix|cook|dev|fix)\b/i.test(uText) ||
          /\[\$(?:ak-cook|ak-vibe|ak-fix|cook)\]/i.test(uText) ||
          /\/(?:ak-cook|ak-vibe|ak-fix|cook|dev|fix)\b/i.test(uText)
        ) {
          return "vibe";
        }
        // If the advisory report was already delivered in a previous turn, AND now a new human user prompt arrives
        // (that isn't a continuation of advise or a task notification), release advise mode!
        if (deliveredAdvisoryReport && !ADVISE_COMMAND_RE.test(uText) && !/<task-notification>/i.test(uText)) {
          return null;
        }
      }

      if (role === "assistant") {
        const contentArr = Array.isArray(m["content"]) ? (m["content"] as Array<Record<string, unknown>>) : [];
        const asstTxt = collectText(m["content"]).join(" ").trim();
        const toolUseBlocks = contentArr.filter((b) => b && typeof b === "object" && b["type"] === "tool_use");

        // Check if assistant performed code editing on source code (not just advisory artifacts)
        for (const b of toolUseBlocks) {
          const name = String(b["name"] ?? "");
          if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
            const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
            const fp = String(input["file_path"] ?? input["path"] ?? "");
            const isAdvisoryArtifact =
              /(?:^|\/|\\)(?:plans|reports|ai_docs|docs|\.?orchestrate|\.mekong|\.claude|\.stitch)\//i.test(fp) ||
              /\.(?:md|html|txt|mmd|svg)$/i.test(fp);
            if (fp && !isAdvisoryArtifact) {
              return "vibe";
            }
          }
          if (/^Bash$/i.test(name)) {
            const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
            const cmd = String(input["command"] ?? "");
            if (/\b(pytest|vitest|jest|npm test|npm run build|cargo test|go test|make)\b/i.test(cmd)) {
              return "vibe";
            }
          }
        }

        // Check for report delivery:
        // Assistant text >= 1500 chars with no tool_use OR only writing to plans/reports/docs
        const onlyAdvisoryTools = toolUseBlocks.every((b) => {
          const name = String(b["name"] ?? "");
          if (/^(Write|Edit)$/i.test(name)) {
            const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
            const fp = String(input["file_path"] ?? input["path"] ?? "");
            return /(?:^|\/|\\)(?:plans|reports|ai_docs|docs)\//i.test(fp) || /\.(?:md|txt)$/i.test(fp);
          }
          return false;
        });

        const isAskUserTurn = toolUseBlocks.some((b) => String(b["name"] ?? "").toLowerCase() === "askuserquestion");

        if (!isAskUserTurn && (toolUseBlocks.length === 0 || onlyAdvisoryTools) && asstTxt.length >= 1500) {
          deliveredAdvisoryReport = true;
          deliveredReportIdx = i;
        }
      }
    }
  }

  return activeMode;
}

export function classifyTask(body: Record<string, unknown>): TaskClassification {
  const s = getTaskSignals(body ?? {});
  const lastUserText = extractLastUserText(body ?? {});
  const userChars = lastUserText.trim().length;
  const isToolTurn = isToolContinuationTurn(body ?? {});
  const reasons: string[] = [];
  const add = (condition: boolean, reason: string): boolean => {
    if (condition) reasons.push(reason);
    return condition;
  };

  const sysOnly = collectText(body?.["system"]).join("\n");

  // Explicit task hints (e.g. from upstream caller, planner, or client header)
  const explicitTask = String((body as Record<string, unknown> | undefined)?.["task"] ?? "").toLowerCase();
  if (explicitTask === "architecture" || explicitTask === "deep_planning") {
    reasons.push("explicit-" + explicitTask, "tier1-architect-argon-high");
    return { level: "heavy", weight: taskWeight("heavy"), ...s, reasons };
  }

  // Empty body -> light
  if (s.promptChars === 0 && s.messageCount === 0 && userChars === 0) {
    reasons.push("empty-body-light");
    return { level: "light", weight: taskWeight("light"), ...s, reasons };
  }

  const effortIsExtreme = /^(xhigh|max|maximum)$/.test(s.effort);
  const effortIsHigh = /^(high|xhigh|max|maximum|hard|deep)$/.test(s.effort);

  // 0a. Auxiliary & Micro-task Detection (titles, compaction, away recap, haiku models):
  const isHaikuRequested = /\bhaiku\b/i.test(s.requestedModel);
  const isAuxiliaryTitle = AUXILIARY_TITLE_RE.test(lastUserText);
  const isCompactionSummary = COMPACTION_SUMMARY_RE.test(lastUserText);
  const isHaikuSubagent =
    /subagent_type["']?\s*:\s*["']?(?:scout|explore|tester)\b/i.test(sysOnly) ||
    /You are a (?:scout|QA Lead)/i.test(sysOnly);

  if ((isHaikuRequested || isAuxiliaryTitle || isCompactionSummary || isHaikuSubagent) && s.outputTokens < 32768) {
    reasons.push(
      isHaikuRequested
        ? "haiku-subagent-flash-high"
        : isAuxiliaryTitle
        ? "auxiliary-title"
        : isCompactionSummary
        ? "compaction-summary"
        : "haiku-subagent-flash-high"
    );
    return {
      level: "light",
      weight: taskWeight("light"),
      ...s,
      reasons,
    };
  }

  // 0b. Explicit Command Mode Routing:
  // - /ak-advise (consulting/strategic advice) -> ALWAYS Tier 1 Architect (Gemini 4 Argon High)
  // - /ak-vibe / /ak-vide / /ak-cook (coding pipeline) -> Tier 2 Heavy Executor (Gemini 4 Argon Medium)
  const activeCommandMode = detectActiveCommandMode(body ?? {});
  if (
    activeCommandMode === "advise" ||
    ADVISE_COMMAND_RE.test(lastUserText) ||
    /subagent_type["']?\s*:\s*["']?(?:advisor|kongming|suntzu|brainstormer|code-reviewer)\b/i.test(sysOnly)
  ) {
    reasons.push("ak-advise-argon-high");
    return {
      level: "heavy",
      weight: taskWeight("heavy"),
      ...s,
      reasons,
    };
  }

  if (activeCommandMode === "vibe" || VIBE_COMMAND_RE.test(lastUserText)) {
    reasons.push("tier2-heavy-coding-argon-medium", "ak-vibe-pure-coding");
    return {
      level: "standard",
      weight: taskWeight("standard"),
      ...s,
      reasons,
    };
  }

  const kickoff = getWorkflowKickoffState(body ?? {});
  const criticalKeywordInUserText = CRITICAL_TASK_RE.test(lastUserText);
  const heavyKeywordInUserText = HEAVY_TASK_RE.test(lastUserText);
  const exactArchInUserText = EXACT_ARCHITECTURE_SIGNALS_RE.test(lastUserText);

  // 0c. Tool-loop continuation routing:
  // Distinguish Tier 2 (tool error retry escalation -> Argon Medium)
  // vs Tier 3 (routine tool-loop continuation without error -> Argon Low)
  if (isToolTurn && !effortIsExtreme) {
    const hasToolError = hasLatestToolResultError(body ?? {});
    if (hasToolError) {
      reasons.push("tier2-heavy-coding-argon-medium", "tool-error-retry");
      return {
        level: "standard",
        weight: taskWeight("standard"),
        ...s,
        reasons,
      };
    }
    reasons.push("tier3-routine-tool-loop-argon-low", "tool-loop-workhorse");
    return {
      level: "standard",
      weight: taskWeight("standard"),
      ...s,
      reasons,
    };
  }

  // 1. Short Greeting & Quick Light Instruction Detection:
  const isExplicitOpusRequest = /\bopus\b/i.test(s.requestedModel);
  const isShortGreeting =
    !isToolTurn &&
    s.messageCount <= 2 &&
    ((/^\s*(hi|hello|hey|yo|ping|test|ok|okay|thanks|thank you|yes|no)\b/i.test(lastUserText) &&
      userChars <= 50) ||
      (userChars > 0 &&
        userChars <= 45 &&
        !HEAVY_TASK_RE.test(lastUserText) &&
        !CRITICAL_TASK_RE.test(lastUserText) &&
        !CODING_TASK_RE.test(lastUserText)));
  const isQuickLightText =
    !isToolTurn &&
    s.lightKeyword &&
    userChars <= 100 &&
    !s.heavyKeyword &&
    !s.criticalKeyword;

  if ((isShortGreeting || isQuickLightText) && s.outputTokens < 32768) {
    reasons.push(isQuickLightText ? "quick-light-instruction" : "short-greeting");
    return {
      level: "light",
      weight: taskWeight("light"),
      ...s,
      reasons,
    };
  }

  // 2. Critical Domain / Security / Zero-Day / Extreme Effort / Huge Output (>= 32k)
  const isHugeContext = !isToolTurn && s.promptChars >= 600_000 && heavyKeywordInUserText;
  const isHugeOutput = !isToolTurn && s.outputTokens >= 32_768;
  const critical =
    add(effortIsExtreme, "extreme-reasoning-effort") ||
    add(isHugeContext, "huge-context-critical") ||
    add(isHugeOutput, "huge-output-tokens-critical") ||
    add(criticalKeywordInUserText && (effortIsHigh || userChars >= 40), "critical-security-domain");

  if (critical) {
    reasons.push("tier1-architect-argon-high");
    return { level: "critical", weight: taskWeight("critical"), ...s, reasons };
  }

  // 3. Genuine Heavy Engineering / Deep Architecture (on fresh human turns)
  if (kickoff.isKickoffCommand || kickoff.isIdeaPhaseTurn || kickoff.isPlanningPhaseTurn) {
    reasons.push(
      kickoff.isIdeaPhaseTurn
        ? "idea-phase-planning"
        : kickoff.isPlanningPhaseTurn
        ? "planning-phase-architecture"
        : "workflow-kickoff-architecture",
      "tier1-architect-argon-high"
    );
    return {
      level: "heavy",
      weight: taskWeight("heavy"),
      ...s,
      reasons,
    };
  }

  const heavySignalCount = [
    add(effortIsHigh, "high-reasoning-effort"),
    add(exactArchInUserText && !isToolTurn, "exact-architecture-signals"),
    add(heavyKeywordInUserText && (userChars >= 15 || effortIsHigh), "deep-architecture-or-planning"),
    add(userChars >= 2500 && heavyKeywordInUserText, "large-architectural-spec"),
    add(
      /subagent_type["']?\s*:\s*["']?(?:advisor|suntzu|kongming|brainstormer|code-reviewer|planner)\b/i.test(sysOnly),
      "tier1-architect-subagent"
    ),
  ].filter(Boolean).length;

  if (heavySignalCount >= 1) {
    reasons.push("tier1-architect-argon-high");
    return { level: "heavy", weight: taskWeight("heavy"), ...s, reasons };
  }

  // 3b. Explicit Opus request on fresh human turn
  if (isExplicitOpusRequest && !isToolTurn) {
    if (heavyKeywordInUserText || effortIsHigh || exactArchInUserText) {
      reasons.push("opus-deep-architecture-request", "tier1-architect-argon-high");
      return { level: "heavy", weight: taskWeight("heavy"), ...s, reasons };
    }
    reasons.push("opus-routine-turn", "tier2-heavy-coding-argon-medium");
    return { level: "standard", weight: taskWeight("standard"), ...s, reasons };
  }

  // 4. Fresh Turn Coding / Heavy Execution: Tier 2 (Argon Medium)
  const strongArchInUserText = STRONG_ARCHITECTURE_SIGNALS_RE.test(lastUserText);
  const codingKeywordInUserText = CODING_TASK_RE.test(lastUserText);
  const isCodingSubagent =
    /subagent_type["']?\s*:\s*["']?(?:fullstack-developer|debugger|developer|coder)\b/i.test(sysOnly);

  if (strongArchInUserText || codingKeywordInUserText || isCodingSubagent || FIX_DEBUG_PROMPT_RE.test(lastUserText)) {
    reasons.push("tier2-heavy-coding-argon-medium");
    return {
      level: "standard",
      weight: taskWeight("standard"),
      ...s,
      reasons,
    };
  }

  // 5. Default: Standard (Tier 2 Heavy Coding Workhorse)
  return {
    level: "standard",
    weight: taskWeight("standard"),
    ...s,
    reasons: reasons.length > 0 ? reasons : ["tier2-heavy-coding-argon-medium"],
  };
}

// ── Model power scoring ───────────────────────────────────────────────────────

/**
 * Estimate how capable a model is on a continuous 0–150 scale, using both
 * registry-derived capabilities and heuristic name matching.
 */
export function modelPowerScore(modelStr: string): number {
  const id = `${modelStr ?? ""}`.toLowerCase();
  const caps = getResolvedModelCapabilities(modelStr);

  let score = 35;
  if (caps.reasoning) score += 18;
  if (caps.supportsVision === true) score += 3;
  if (caps.toolCalling) score += 3;

  const ctx = caps.contextWindow ?? 0;
  if (ctx >= 1_000_000) score += 22;
  else if (ctx >= 400_000) score += 15;
  else if (ctx >= 200_000) score += 9;
  else if (ctx > 0 && ctx <= 32_000) score -= 10;

  const maxOut = caps.maxOutputTokens ?? 0;
  if (maxOut >= 128_000) score += 12;
  else if (maxOut >= 64_000) score += 8;
  else if (maxOut > 0 && maxOut <= 8_192) score -= 8;

  // Zunef / Anthropic Claude model power normalization when caps are not in registry
  if (id.startsWith("zunef/") || id.includes("claude-") || id.includes("gpt-5")) {
    if (/\b(haiku|mini|flash-lite|flash-low)\b/i.test(id)) return 35;
    if (/\b(opus-5-5|opus-5|gpt-5\.4(?!-mini)|gpt-5\.3-codex)\b/i.test(id)) return 135;
    if (/\b(sonnet-5-5|sonnet-5|fable|codex)\b/i.test(id)) return 100;
  }

  // Lightweight check with word boundary safety (exclude frontier models)
  const isFrontierOrTiered = /\b(gemini-4|argon|astra|sol|opus|ultra|flash-high|flash-medium|flash-tiered|gpt-5\.4(?!-mini)|gpt-5\.3)\b/i.test(id);
  const isLightweight = !isFrontierOrTiered && /\b(luna|flash-lite|flash-low|gpt-oss|haiku|instant|nano|mini|small|lite|turbo|8b|7b)\b/i.test(id);

  if (isLightweight) {
    if (/\b(flash-low)\b/i.test(id)) return 36;
    if (/\b(flash-lite)\b/i.test(id)) return 35;
    if (/\b(gpt-oss)\b/i.test(id)) return 39;
    return Math.max(20, Math.min(45, score - 35));
  }

  // Tier 1: Frontier Flagship (Power 134) -> "Dao mổ trâu" (Carbon Opus & Argon High)
  if (!/\b(argon-medium|argon-low|gemini-4-medium|gemini-4-low)\b/i.test(id) && /\b(astra|argon-high|argon|gemini-4|opus-4-6|opus-4-7|opus-4-8|opus-5|ultra|o3-high|o4|gpt-5\.4(?!-mini)|gpt-5\.3-codex)\b/i.test(id)) {
    score += 45;
  }
  // Tier 2: Heavy Workhorse (Power 121) -> "Gươm sắc" (Carbon Sonnet & Argon Medium)
  else if (/\b(sol|sonnet-5|sonnet-4|argon-medium|gemini-4-medium|deepseek-v4-pro|opus|glm-5|codex)\b/i.test(id)) {
    score += 32;
  }
  // Tier 3: Standard Workhorse (Power 104) -> "Dao thái thịt" (Gemini 3.8 Flash High/Tiered/Medium & Argon Low)
  else if (/\b(terra|flash-tiered|flash-high|flash-medium|argon-low|gemini-4-low|gemini-3\.8|gemini-3\.6|gemini-3-flash|pro|coder)\b/i.test(id)) {
    score += 15;
  }

  if (/\b(coder|code|coding)\b/i.test(id)) score += 5;

  return Math.max(0, Math.min(150, score));
}

// Hard capabilities: missing one drops request data (images, PDFs). Maps TS
// ResolvedModelCapabilities fields that correspond to hard-cap modalities.
const HARD_CAP_CHECKS = new Set(["vision"]);

/**
 * Score a single model for a given task + capability requirements.
 * Higher score = better fit. Negative score = capability hard-miss.
 */
export function scoreModelForTask(
  modelStr: string,
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set()
): number {
  const caps = getResolvedModelCapabilities(modelStr);
  const modelLower = String(modelStr ?? "").toLowerCase();

  // URGENT USER REQUIREMENT: Completely ban zunef/*4-6* models (very slow!)
  if (modelLower.startsWith("zunef/") && (modelLower.includes("4-6") || modelLower.includes("4.6"))) {
    return -99999;
  }

  // Hard capabilities: missing one drops request data (images, PDFs)
  for (const cap of required) {
    if (!HARD_CAP_CHECKS.has(cap)) continue;
    if (cap === "vision" && caps.supportsVision !== true) return -10000;
  }

  const requestedModel = (task.requestedModel ?? "").toLowerCase();
  const reasons = Array.isArray(task.reasons) ? task.reasons : [];

  // Identify Haiku / Auxiliary tasks:
  const isHaikuOrAuxiliary =
    /\bhaiku\b/i.test(requestedModel) ||
    reasons.some((r) => r.includes("haiku") || r.includes("title") || r.includes("compaction")) ||
    (task.level === "light" && !reasons.includes("short-greeting"));

  // ── 1. HAIKU / AUXILIARY ROUTING ───────────────────────────────────────────
  // Replace Haiku 5.5 / 4.5 with Gemini 3.8 Flash High.
  // CRITICAL: NEVER burn Gemini 4 Argon quota on Haiku tasks!
  if (isHaikuOrAuxiliary) {
    if (modelLower.includes("argon") || modelLower.includes("gemini-4")) {
      return -5000; // Argon strictly banned from Haiku tasks!
    }
    if (modelLower === "agy/gemini-3.8-flash-high") return 1350;
    if (modelLower === "antigravity/gemini-3.8-flash-high" || modelLower === "gemini-3.8-flash-high") return 1340;
    if (modelLower === "agy/gemini-3.8-flash-medium") return 950;
    if (modelLower === "zunef/claude-haiku-4-5") return 940;
    if (modelLower === "antigravity/gemini-3.8-flash-tiered" || modelLower === "agy/gemini-3.8-flash-tiered") return 930;
    if (modelLower.includes("flash")) return 850;
    return 500;
  }

  // ── 1b. ANTIGRAVITY CLAUDE 5.5 = #3 BACKUP TIER BEHIND ZUNEF ─────────────
  // Zunef Opus/Sonnet 5.5 stay #1/#2 (1500/1450). When Zunef is slow/429/timeout the combo
  // falls to the same Claude 5.5 family served by Antigravity accounts (priority order
  // billwill+longtho -> cashback -> ntnha via connection priority) BEFORE any Argon (<=1350).
  {
    const agyClaude = /^(agy|antigravity)\/claude-(opus|sonnet)-5-5-(high|medium|low)$/.exec(modelLower);
    if (agyClaude) {
      const owner = agyClaude[1] === "agy" ? 5 : 0; // owner pool (agy) slightly ahead of slot-farm
      const fam = agyClaude[2];
      const eff = agyClaude[3];
      const isRoutineLoop = reasons.some((r) => r.includes("tier3") || r.includes("tool-loop-workhorse"));
      const table: Record<string, number> = isRoutineLoop
        ? { "sonnet-medium": 1435, "opus-medium": 1425, "sonnet-low": 1415, "sonnet-high": 1405, "opus-high": 1395, "opus-low": 1385 }
        : { "opus-high": 1435, "sonnet-high": 1425, "opus-medium": 1415, "sonnet-medium": 1405, "opus-low": 1385, "sonnet-low": 1380 };
      return (table[`${fam}-${eff}`] ?? 1370) + owner;
    }
  }

  // ── 2. NON-HAIKU (CODING / ADVISE / ARCHITECTURE / ROUTINE) ─────────────────
  // CRITICAL USER REQUIREMENT: Eliminate Gemini 3.8 Flash from coding! ("k cho 3.8 code nữa")
  if (modelLower.includes("flash") || modelLower.includes("3.8-flash") || modelLower.includes("3.6-flash")) {
    return -5000;
  }

  // ── 3. TIER 1: ARCHITECT / ADVISOR (10-15% of turns) ────────────────────────
  // Explicit /ak-advise / [$ak-advise] consulting: Gemini 4 Argon High is #1 Primary above Zunef!
  const isAdvise = reasons.includes("ak-advise-argon-high");
  if (isAdvise) {
    if (modelLower === "zunef/claude-opus-5-5") return 1500;
    if (modelLower === "zunef/claude-sonnet-5-5") return 1450;
    if (modelLower === "agy/gemini-4-argon-high") return 1350;
    if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 1340;
    if (modelLower === "agy/gemini-4-argon-medium") return 900;
    if (modelLower === "antigravity/gemini-4-argon-medium" || modelLower === "gemini-4-argon-medium") return 890;
    if (modelLower === "agy/gemini-4-argon-low") return 800;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 790;
    return 700;
  }

  // Tier 1 Architect / Heavy / Critical (kickoff, critical domain, system design):
  const isTier1Architect =
    task.level === "heavy" ||
    task.level === "critical" ||
    reasons.some(
      (r) =>
        r.includes("architect") ||
        r.includes("idea-phase") ||
        r.includes("planning-phase") ||
        r.includes("workflow-kickoff") ||
        r.includes("critical")
    );

  if (isTier1Architect) {
    if (modelLower === "zunef/claude-opus-5-5") return 1500;
    if (modelLower === "zunef/claude-sonnet-5-5") return 1450;
    if (modelLower === "agy/gemini-4-argon-high") return 1350;
    if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 1340;
    if (modelLower === "agy/gemini-4-argon-medium") return 1150;
    if (modelLower === "antigravity/gemini-4-argon-medium" || modelLower === "gemini-4-argon-medium") return 1140;
    if (modelLower === "agy/gemini-4-argon-low") return 900;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 890;
    return 800;
  }

  // ── 4. TIER 3: FAST TOOL-LOOP EXECUTOR (40-55% of turns) ───────────────────
  // Routine tool-loop continuation without errors (Read, Grep, Bash, git diff/status) -> Gemini 4 Argon Low.
  // Argon High is penalized with 850 (-200 vs normal) so it is NEVER wasted on routine tool loops!
  const isTier3RoutineToolLoop = reasons.some((r) => r.includes("tier3") || r.includes("tool-loop-workhorse"));
  if (isTier3RoutineToolLoop) {
    if (modelLower === "zunef/claude-opus-5-5") return 1500;
    if (modelLower === "zunef/claude-sonnet-5-5") return 1450;
    if (modelLower === "agy/gemini-4-argon-low") return 1290;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 1280;
    if (modelLower === "agy/gemini-4-argon-medium") return 1180;
    if (modelLower === "antigravity/gemini-4-argon-medium" || modelLower === "gemini-4-argon-medium") return 1170;
    if (modelLower === "agy/gemini-4-argon-high") return 850; // Penalized!
    if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 840;
    return 800;
  }

  // ── 5. TIER 2: HEAVY EXECUTOR / MULTI-FILE CODING (35-45% of turns) ────────
  // /ak-vibe, /ak-cook, fullstack-developer, debugger, /ak-fix, tool error retry -> Gemini 4 Argon Medium.
  if (modelLower === "zunef/claude-opus-5-5") return 1500;
  if (modelLower === "zunef/claude-sonnet-5-5") return 1450;
  if (modelLower === "agy/gemini-4-argon-medium") return 1280;
  if (modelLower === "antigravity/gemini-4-argon-medium" || modelLower === "gemini-4-argon-medium") return 1270;
  if (modelLower === "agy/gemini-4-argon-low") return 1150;
  if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 1140;
  if (modelLower === "agy/gemini-4-argon-high") return 1050; // Backup
  if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 1040;

  // General fallback for unknown models
  let score = modelPowerScore(modelStr);
  if (modelLower.startsWith("zunef/")) score += 500;
  else if (modelLower.startsWith("agy/")) score += 14;
  else if (modelLower.startsWith("antigravity/")) score += 10;
  return score;
}

export function reorderByTaskWeight(
  targets: ResolvedComboTarget[],
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set()
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) return targets;

  const scored = targets.map((t, i) => ({ t, i, score: scoreModelForTask(t.modelStr, task, required) }));
  try {
    const scoreSummary = scored.map((s) => s.t.modelStr + "=" + s.score).join(", ");
    console.log("[TASK_AWARE] task=" + task.level + " reasons=" + task.reasons.join(",") + " | scores: " + scoreSummary);
  } catch {}

  const flipTie = (Date.now() + Math.floor(Math.random() * 2)) % 2 === 1;
  const reordered = scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aIsZunef = a.t.modelStr.toLowerCase().startsWith("zunef/");
      const bIsZunef = b.t.modelStr.toLowerCase().startsWith("zunef/");
      if (aIsZunef !== bIsZunef) return aIsZunef ? -1 : 1;
      const aIsOwner = a.t.modelStr.toLowerCase().startsWith("agy/");
      const bIsOwner = b.t.modelStr.toLowerCase().startsWith("agy/");
      if (aIsOwner !== bIsOwner) return aIsOwner ? -1 : 1;
      const aIsCarbon = /claude-/i.test(a.t.modelStr);
      const bIsCarbon = /claude-/i.test(b.t.modelStr);
      const aIsArgon = /argon/i.test(a.t.modelStr);
      const bIsArgon = /argon/i.test(b.t.modelStr);
      if (flipTie && ((aIsCarbon && bIsArgon) || (aIsArgon && bIsCarbon))) {
        return b.i - a.i;
      }
      return a.i - b.i;
    })
    .map((x) => x.t);

  return reordered.every((t, i) => t === targets[i]) ? targets : reordered;
}

// ── Conversation affinity (cache-key derivation) ──────────────────────────────

function normalizeFingerprintText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function firstRoleText(
  items: unknown[],
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (!roles.has(String(rec["role"] ?? ""))) continue;
    const raw = contentKey === "parts" ? rec["parts"] : rec["content"];
    const text = normalizeFingerprintText(collectText(raw).join("\n"));
    if (text) return text;
  }
  return "";
}

function allRoleText(
  items: unknown[],
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  return normalizeFingerprintText(
    items
      .filter(
        (item): item is Record<string, unknown> =>
          !!item &&
          typeof item === "object" &&
          roles.has(String((item as Record<string, unknown>)["role"] ?? ""))
      )
      .map((item) =>
        collectText(contentKey === "parts" ? item["parts"] : item["content"]).join("\n")
      )
      .filter(Boolean)
      .join("\n")
  );
}

function hashConversationSeed(seed: string): string | null {
  const normalized = normalizeFingerprintText(seed);
  if (!normalized) return null;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 24);
}

/**
 * Derive a stable cache-affinity key from explicit thread metadata when present,
 * otherwise from the immutable start of the prompt (system + first user turn).
 * Appended turns should not move an existing conversation to another model.
 */
export function getConversationCacheKey(body: Record<string, unknown>): string | null {
  if (!body || typeof body !== "object") return null;

  const meta = body["metadata"] as Record<string, unknown> | undefined;
  const explicitCandidates = [
    body["conversation_id"],
    body["conversationId"],
    body["thread_id"],
    body["threadId"],
    body["session_id"],
    body["sessionId"],
    meta?.["conversation_id"],
    meta?.["conversationId"],
    meta?.["thread_id"],
    meta?.["threadId"],
    meta?.["session_id"],
    meta?.["sessionId"],
  ];
  const explicit = explicitCandidates.find((v) => v != null && String(v).trim());
  if (explicit != null) return hashConversationSeed(`explicit:${String(explicit).trim()}`);

  const systemRoles = new Set(["system", "developer"]);
  const userRoles = new Set(["user"]);
  const contents =
    (body["contents"] as unknown[]) ??
    ((body["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown[]);

  const seedParts = [
    collectText(body["system"]).join("\n"),
    collectText(body["instructions"]).join("\n"),
    allRoleText((body["messages"] as unknown[]) ?? [], systemRoles),
    allRoleText((body["input"] as unknown[]) ?? [], systemRoles),
    allRoleText(contents ?? [], systemRoles, "parts"),
    firstRoleText((body["messages"] as unknown[]) ?? [], userRoles),
    typeof body["input"] === "string"
      ? body["input"]
      : firstRoleText((body["input"] as unknown[]) ?? [], userRoles),
    firstRoleText(contents ?? [], userRoles, "parts"),
    body["query"],
    body["url"],
  ].filter(Boolean);

  return hashConversationSeed(seedParts.join("\n"));
}

// ── Affinity management (for round-robin integration) ────────────────────────

export function pruneConversationAffinity(now = Date.now()): void {
  for (const [key, value] of comboConversationAffinity) {
    if (!value || now - value.lastUsed > CONVERSATION_AFFINITY_TTL_MS) {
      comboConversationAffinity.delete(key);
    }
  }
  while (comboConversationAffinity.size > MAX_CONVERSATION_AFFINITY_ENTRIES) {
    const oldestKey = comboConversationAffinity.keys().next().value;
    if (oldestKey === undefined) break;
    comboConversationAffinity.delete(oldestKey);
  }
}

export function getOrSetConversationAffinityIndex(
  rotationKey: string,
  conversationCacheKey: string,
  currentIndex: number
): number {
  const now = Date.now();
  pruneConversationAffinity(now);

  const affinityKey = `${rotationKey}:${conversationCacheKey}`;
  const existing = comboConversationAffinity.get(affinityKey);
  if (existing) {
    const pinnedIndex = existing.index;
    comboConversationAffinity.delete(affinityKey);
    comboConversationAffinity.set(affinityKey, { index: pinnedIndex, lastUsed: now });
    return pinnedIndex;
  }

  comboConversationAffinity.set(affinityKey, { index: currentIndex, lastUsed: now });
  return currentIndex;
}

export function clearConversationAffinity(comboName?: string): void {
  if (comboName) {
    const prefix = `${comboName}:`;
    for (const key of comboConversationAffinity.keys()) {
      if (key.startsWith(prefix)) comboConversationAffinity.delete(key);
    }
  } else {
    comboConversationAffinity.clear();
  }
}

// HMR_BUMP_PARENT_GUARDRAILS_1793449523910
