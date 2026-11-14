/**
 * Curated READ-ONLY MCP tool profile for the HTTP transports (Claude Code and other
 * HTTP MCP clients).
 *
 * Announcing all 105 tools over HTTP costs every client the full schema manifest on
 * connect and degrades tool-selection accuracy. The HTTP transports therefore default to
 * a small, read-only subset oriented at context retrieval — memory, skills, the model
 * catalog, web/local-corpus search — plus `omniroute_tool_search` for token-efficient
 * discovery. No write/admin/execute-completion tool is announced by default.
 *
 * Operators can widen or narrow the set with the existing cardinality env vars:
 *
 *   MCP_TOOL_ALLOW=all                  → announce the full catalog again
 *   MCP_TOOL_ALLOW=<comma-separated>    → exact allow-list (overrides the curated default)
 *   MCP_TOOL_DENY=<comma-separated>     → always drop these names (wins over allow)
 *
 * The stdio transport keeps its historical behaviour (all tools unless the env vars are
 * set) — see `createMcpServer()` in `server.ts` and `readMcpToolProfileFromEnv()`.
 */

import type { ToolProfile } from "./toolCardinality.ts";

/** Profile name reported in docs/tests when the curated default is active. */
export const MCP_HTTP_READ_ONLY_PROFILE_NAME = "read-only";

/**
 * The curated context-retrieval surface. Every entry is a real tool registered by
 * `createMcpServer()` (pinned by `tests/unit/mcp/read-only-tool-profile.test.ts`).
 *
 * Read-only by construction: each tool's scopes are `read:*` scopes, or
 * `execute:search` for the two outbound web-search tools (they do not mutate
 * OmniRoute state and are the "search" leg of context retrieval).
 */
export const READ_ONLY_CONTEXT_TOOL_NAMES: readonly string[] = Object.freeze([
  // Deferred tool discovery — compact one-line signatures instead of full schemas.
  "omniroute_tool_search",
  // Memory retrieval.
  "omniroute_memory_search",
  // Skills catalog + read-only execution history.
  "omniroute_skills_list",
  "omniroute_skills_executions",
  // Agent-skill catalog (read:catalog).
  "omniroute_agent_skills_list",
  "omniroute_agent_skills_get",
  "omniroute_agent_skills_coverage",
  // Model catalog.
  "omniroute_list_models_catalog",
  // Web search / fetch (read-only outbound; no gateway mutation).
  "omniroute_web_search",
  "omniroute_web_fetch",
  // Local corpus retrieval.
  "local_corpus_status",
  "local_corpus_search",
  "local_corpus_read",
]);

/**
 * Scopes that are read-only in effect but do not start with `read:`. Kept explicit so a new
 * non-read scope cannot silently join the curated profile — the unit test checks every
 * curated tool against this rule.
 */
export const READ_ONLY_EXTRA_SCOPES: readonly string[] = Object.freeze(["execute:search"]);

/** `MCP_TOOL_ALLOW` values that mean "announce everything". Mirrors toolCardinality.ts. */
const ALL_TOOLS_SENTINEL = new Set(["all", "*"]);

/** True when `scope` is safe for a read-only tool profile. */
export function isReadOnlyMcpScope(scope: string): boolean {
  return scope.startsWith("read:") || READ_ONLY_EXTRA_SCOPES.includes(scope);
}

function parseToolNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Resolve the tool profile for the HTTP transports.
 *
 * Returns `null` when no filtering should run (full catalog). Precedence:
 *   1. `MCP_TOOL_ALLOW=all|*`        → no allow filter; `MCP_TOOL_DENY` still applies.
 *   2. `MCP_TOOL_ALLOW=<names>`      → exact operator allow-list (replaces curated default).
 *   3. (unset)                       → curated {@link READ_ONLY_CONTEXT_TOOL_NAMES}.
 * `MCP_TOOL_DENY` always wins over the allow side.
 */
export function readMcpHttpToolProfile(
  env: Record<string, string | undefined> = process.env
): ToolProfile | null {
  const denyTools = parseToolNames(env["MCP_TOOL_DENY"]);
  const rawAllowTools = parseToolNames(env["MCP_TOOL_ALLOW"]);
  const allowAll = rawAllowTools.some((name) => ALL_TOOLS_SENTINEL.has(name.toLowerCase()));

  if (allowAll) {
    return denyTools.length > 0 ? { name: "full", denyTools } : null;
  }

  const explicitAllow = rawAllowTools.length > 0;
  const allowTools = explicitAllow ? rawAllowTools : [...READ_ONLY_CONTEXT_TOOL_NAMES];

  return {
    name: explicitAllow ? "custom" : MCP_HTTP_READ_ONLY_PROFILE_NAME,
    allowTools,
    ...(denyTools.length > 0 ? { denyTools } : {}),
  };
}
