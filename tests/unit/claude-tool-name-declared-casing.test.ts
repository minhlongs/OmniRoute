/**
 * Tool-name casing when NOTHING was sanitised on our side.
 *
 * The response translators restore names from an alias ledger, but the ledger
 * only exists when the request adapter rewrote something. A model can still
 * emit `bash` for a tool the client declared as `Bash` — and clients such as
 * Claude Code are case-sensitive ("No such tool available: bash. Tool names are
 * case-sensitive: call Bash instead."). The declared tool list is the only
 * source of truth available in that case.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveResponseToolNameMap, buildDeclaredToolNameMap } =
  await import("../../open-sse/handlers/chatCore/requestToolIdentity.ts");
const { restoreClaudeToolName } = await import("../../open-sse/services/claudeCodeToolRemapper.ts");

test("declared tool names produce an identity ledger", () => {
  const ledger = buildDeclaredToolNameMap([{ name: "Bash" }, { name: "Read" }, { nope: 1 }]);
  assert.ok(ledger instanceof Map);
  assert.equal(ledger?.get("Bash"), "Bash");
  assert.equal(ledger?.get("Read"), "Read");
  assert.equal(ledger?.size, 2);
});

test("no declared tools and no other ledger stays null (unchanged behaviour)", () => {
  assert.equal(resolveResponseToolNameMap(null, null, null), null);
  assert.equal(buildDeclaredToolNameMap(undefined), null);
  assert.equal(buildDeclaredToolNameMap([]), null);
});

test("an existing sanitisation ledger still wins over the declared list", () => {
  const sanitised = new Map([["bash", "Bash"]]);
  const resolved = resolveResponseToolNameMap(sanitised, null, null, [{ name: "Other" }]);
  // The merged ledger is a copy, but the sanitisation alias still wins.
  assert.equal(resolved?.get("bash"), "Bash");
  assert.equal(resolved?.get("Other"), "Other");
});

test("a lowercase model emission is restored to the declared casing", () => {
  const map = resolveResponseToolNameMap(null, null, null, [{ name: "Bash" }]);
  assert.equal(restoreClaudeToolName("bash", map), "Bash");
});

test("a casing-only difference on a custom tool is restored too", () => {
  const map = resolveResponseToolNameMap(null, null, null, [{ name: "fetchDatabase" }]);
  assert.equal(restoreClaudeToolName("fetchdatabase", map), "fetchDatabase");
});
