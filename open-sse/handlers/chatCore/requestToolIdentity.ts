export type NamespaceIdentity = { namespace: string; name: string };

/**
 * Return a string-valued copy only when the complete map is an alias ledger.
 *
 * The legacy `_toolNameMap` side channel can carry either response aliases or
 * namespace identities. Checking every value before copying keeps those two
 * contracts separate and gives callers a real `Map<string, string>` instead of
 * asserting an identity map into the alias shape.
 */
export function toToolNameAliasMap(
  map: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (!map || map.size === 0) return null;

  const aliases = new Map<string, string>();
  for (const [wireName, originalName] of map) {
    if (typeof originalName !== "string") return null;
    aliases.set(wireName, originalName);
  }
  return aliases;
}

/**
 * Decide which alias ledger the response translator gets.
 *
 * The ordering here is load-bearing. `extractRequestToolIdentityMap` runs
 * earlier in the request and DELETES `translatedBody._toolNameMap`, so by the
 * time the response map is resolved that property is already gone and
 * `translatedToolNameMap` is undefined for every Gemini/Antigravity request.
 * Without the `requestToolIdentityMap` fallback the ledger is silently dropped,
 * the response translator has nothing to reverse the sanitized wire name with
 * (`mcp__chrome-devtools__list_pages` goes out as
 * `mcp_chrome_devtools_list_pages`), and clients reject every MCP tool call
 * with "No such tool available" (#9568 / #7936).
 *
 * Only string-valued ledgers are recovered — `toToolNameAliasMap` returns null
 * for object-valued namespace identities so those are not reinterpreted as
 * response aliases.
 */
export function resolveResponseToolNameMap(
  translatedToolNameMap: unknown,
  nativeClaudeToolNameMap: Map<string, string> | null,
  requestToolIdentityMap: ReadonlyMap<string, unknown> | null,
  declaredTools: unknown = null
): Map<string, string> | null {
  const declared = buildDeclaredToolNameMap(declaredTools);
  if (translatedToolNameMap instanceof Map && translatedToolNameMap.size > 0) {
    return mergeToolNameMaps(translatedToolNameMap as Map<string, string>, declared);
  }
  const ledger = nativeClaudeToolNameMap ?? toToolNameAliasMap(requestToolIdentityMap);
  if (ledger && ledger.size > 0) return mergeToolNameMaps(ledger, declared);
  // Last resort: the client's own tool list. A model can emit `bash` for a tool
  // the client declared as `Bash` without any sanitisation happening on our side
  // (nothing to put in the ledger), and the client is case-sensitive:
  // "No such tool available: bash. Tool names are case-sensitive: call Bash
  // instead." An identity ledger lets restoreClaudeToolName()'s case-insensitive
  // branch map the name back to the exact casing the client declared.
  return declared;
}

/**
 * Fold the declared-tool identity ledger into whichever alias ledger won.
 *
 * The passthrough ledger only knows the well-known Claude Code tool names, so a
 * harness tool such as `ListAgents` or `AskUserQuestion` is absent from it and a
 * lowercased emission (`listagents`) cannot be restored — the client then loops
 * on "No such tool available". The declared list is the only ledger that knows
 * every tool this request actually exposes, so it is merged in.
 *
 * `base` wins on conflict (case-insensitively): a real sanitisation alias must
 * never be replaced by the identity entry.
 */
export function mergeToolNameMaps(
  base: Map<string, string> | null | undefined,
  extra: Map<string, string> | null | undefined
): Map<string, string> | null {
  if (!base || base.size === 0) return extra ?? null;
  if (!extra || extra.size === 0) return base;
  const merged = new Map(base);
  const taken = new Set<string>();
  for (const key of base.keys()) taken.add(key.toLowerCase());
  for (const [key, value] of extra) {
    if (taken.has(key.toLowerCase())) continue;
    merged.set(key, value);
  }
  return merged;
}

/**
 * Build an identity alias ledger (`declared name -> declared name`) from the
 * request's `tools[]`. Returns null when there is nothing to learn from.
 */
export function buildDeclaredToolNameMap(tools: unknown): Map<string, string> | null {
  if (!Array.isArray(tools)) return null;
  const ledger = new Map<string, string>();
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.length > 0) ledger.set(name, name);
  }
  return ledger.size > 0 ? ledger : null;
}

/**
 * Extract the #7936 request-tool identity map from the translated body and
 * strip both side channels before dispatch.
 *
 * #9780 — prefer the dedicated `_namespaceToolIdentityMap`: on a pivot the
 * openai->claude/gemini step publishes its own alias `Map<string, string>` on
 * `_toolNameMap`, so that property alone can yield aliases instead of
 * identities. The `_toolNameMap` read stays as the fallback for the non-pivot
 * producers (executors/base.ts, cliproxyapi.ts, antigravity).
 */
export function extractRequestToolIdentityMap(
  translatedBody: Record<string, unknown>
): Map<string, NamespaceIdentity> | null {
  const namespaceIdentityMap = translatedBody._namespaceToolIdentityMap;
  const requestToolIdentityMap =
    namespaceIdentityMap instanceof Map
      ? namespaceIdentityMap
      : translatedBody._toolNameMap instanceof Map
        ? translatedBody._toolNameMap
        : null;
  delete translatedBody._namespaceToolIdentityMap;
  delete translatedBody._toolNameMap;
  return requestToolIdentityMap as Map<string, NamespaceIdentity> | null;
}
