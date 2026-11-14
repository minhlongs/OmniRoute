import { getAllToolDefinitions } from "./catalog.ts";
import { searchTools } from "./search.ts";
import { zodToTsSignature } from "./signature.ts";

/**
 * Search the MCP tool catalog.
 *
 * `allowedToolNames` scopes deferred discovery to the tools actually announced by the active
 * server profile (the HTTP transports default to the curated read-only set), so tool search can
 * never advertise a tool that `tools/list` disabled. `null`/`undefined` means no filtering.
 */
export function handleToolSearch(
  args: { query: string; limit?: number },
  allowedToolNames?: ReadonlySet<string> | null
) {
  let entries = getAllToolDefinitions().filter((t) => t.name !== "omniroute_tool_search");
  if (allowedToolNames) {
    entries = entries.filter((t) => allowedToolNames.has(t.name));
  }
  const hits = searchTools(entries, args.query, args.limit ?? 8);
  return {
    query: args.query,
    count: hits.length,
    tools: hits.map((h) => ({
      name: h.name,
      description: h.description,
      scopes: [...h.scopes],
      signature: zodToTsSignature(h.name, h.inputSchema),
    })),
  };
}
