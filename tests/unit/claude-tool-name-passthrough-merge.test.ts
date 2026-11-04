/**
 * Passthrough ledger + declared tools.
 *
 * When a Claude-format client talks to an Anthropic-native provider, OmniRoute
 * passes the stream through. The passthrough ledger only knows the well-known
 * Claude Code tool names, so a harness tool such as `ListAgents` or
 * `AskUserQuestion` was absent from it and a lowercased emission (`listagents`)
 * could not be restored — the client then loops on
 * "No such tool available: listagents ... call ListAgents instead."
 *
 * The declared tool list is the only ledger that knows every tool the request
 * exposes, so it is merged into whichever ledger won.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveResponseToolNameMap, mergeToolNameMaps } =
  await import("../../open-sse/handlers/chatCore/requestToolIdentity.ts");
const { restoreClaudeToolName } = await import("../../open-sse/services/claudeCodeToolRemapper.ts");

test("merge keeps base entries and adds declared ones", () => {
  const base = new Map([["bash", "bash"]]);
  const merged = mergeToolNameMaps(base, new Map([["ListAgents", "ListAgents"]]));
  assert.equal(merged?.get("bash"), "bash");
  assert.equal(merged?.get("ListAgents"), "ListAgents");
});

test("base wins on a case-insensitive collision", () => {
  const base = new Map([["bash", "Bash"]]);
  const merged = mergeToolNameMaps(base, new Map([["Bash", "SomethingElse"]]));
  assert.equal(merged?.get("bash"), "Bash");
  assert.equal(merged?.size, 1);
});

test("merge tolerates a missing side", () => {
  assert.equal(mergeToolNameMaps(null, null), null);
  const only = new Map([["X", "X"]]);
  assert.equal(mergeToolNameMaps(null, only), only);
  assert.equal(mergeToolNameMaps(only, null), only);
});

test("a passthrough ledger now restores an unknown harness tool's casing", () => {
  // The passthrough ledger knows only Claude Code's own tools.
  const passthrough = new Map([["bash", "bash"]]);
  const resolved = resolveResponseToolNameMap(null, passthrough, null, [
    { name: "ListAgents" },
    { name: "AskUserQuestion" },
  ]);
  assert.equal(restoreClaudeToolName("listagents", resolved), "ListAgents");
  assert.equal(restoreClaudeToolName("askuserquestion", resolved), "AskUserQuestion");
  // The passthrough entry still flows to its canonical Claude name.
  assert.equal(restoreClaudeToolName("bash", resolved), "Bash");
});

test("an untouched declared name still passes through unchanged", () => {
  const resolved = resolveResponseToolNameMap(null, null, null, [{ name: "ListAgents" }]);
  assert.equal(restoreClaudeToolName("ListAgents", resolved), "ListAgents");
});
