import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tool modules pull in DB-backed services at import time; point DATA_DIR at a temp dir so the
// focused `node --test` run never touches the operator's real ~/.omniroute data.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mcp-readonly-profile-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// The HTTP transports (Claude Code and other HTTP MCP clients) announce a curated READ-ONLY
// subset instead of the full ~105-tool catalog. These tests pin the curated set to real
// registered tools, prove it contains no write/admin surface, and cover the env overrides that
// let an operator restore or customise the catalog.

const {
  MCP_HTTP_READ_ONLY_PROFILE_NAME,
  READ_ONLY_CONTEXT_TOOL_NAMES,
  isReadOnlyMcpScope,
  readMcpHttpToolProfile,
} = await import("../../../open-sse/mcp-server/readOnlyToolProfile.ts");
const { readMcpToolProfileFromEnv, reduceToolManifest } = await import(
  "../../../open-sse/mcp-server/toolCardinality.ts"
);
type ToolProfile = import("../../../open-sse/mcp-server/toolCardinality.ts").ToolProfile;
const { getAllToolDefinitions } = await import(
  "../../../open-sse/mcp-server/toolSearch/catalog.ts"
);
const { handleToolSearch } = await import(
  "../../../open-sse/mcp-server/toolSearch/handler.ts"
);

const CATALOG = getAllToolDefinitions();
const CATALOG_BY_NAME = new Map(CATALOG.map((tool) => [tool.name, tool]));

function announcedNames(profile: ToolProfile): string[] {
  return reduceToolManifest(CATALOG, profile).map((tool) => tool.name);
}

test("the curated profile names only real registered tools", () => {
  const missing = READ_ONLY_CONTEXT_TOOL_NAMES.filter((name) => !CATALOG_BY_NAME.has(name));
  assert.deepEqual(missing, [], `curated names missing from the live catalog: ${missing.join(", ")}`);
  assert.equal(
    READ_ONLY_CONTEXT_TOOL_NAMES.length,
    13,
    "the curated HTTP profile is pinned at 13 tools — update the docs and this assertion together"
  );
});

test("the curated profile contains no write, admin, or execute-completion tool", () => {
  for (const name of READ_ONLY_CONTEXT_TOOL_NAMES) {
    const tool = CATALOG_BY_NAME.get(name);
    assert.ok(tool, `${name} must exist in the catalog`);
    assert.ok(tool.scopes.length > 0, `${name} must declare at least one scope`);
    for (const scope of tool.scopes) {
      assert.ok(
        isReadOnlyMcpScope(scope),
        `${name} declares non-read-only scope "${scope}" — it must not be in the curated profile`
      );
      assert.ok(
        !/^(write|admin):/.test(scope),
        `${name} must not require a write/admin scope (got "${scope}")`
      );
    }
  }
});

test("HTTP default resolves to the curated read-only profile", () => {
  const profile = readMcpHttpToolProfile({});
  assert.ok(profile, "the HTTP transports must never default to the full catalog");
  assert.equal(profile.name, MCP_HTTP_READ_ONLY_PROFILE_NAME);
  assert.deepEqual([...(profile.allowTools ?? [])].sort(), [...READ_ONLY_CONTEXT_TOOL_NAMES].sort());
  assert.deepEqual(announcedNames(profile).sort(), [...READ_ONLY_CONTEXT_TOOL_NAMES].sort());
});

test("stdio default stays unfiltered for backward compatibility", () => {
  assert.equal(readMcpToolProfileFromEnv({}), null);
});

test("MCP_TOOL_ALLOW=all restores the full catalog on both transports", () => {
  assert.deepEqual(readMcpHttpToolProfile({ MCP_TOOL_ALLOW: "all" }), null);
  assert.deepEqual(readMcpHttpToolProfile({ MCP_TOOL_ALLOW: "*" }), null);
  assert.equal(readMcpToolProfileFromEnv({ MCP_TOOL_ALLOW: "all" }), null);
  assert.equal(getAllToolDefinitions().length, 110);
});

test("an explicit MCP_TOOL_ALLOW replaces the curated HTTP default", () => {
  const profile = readMcpHttpToolProfile({
    MCP_TOOL_ALLOW: "omniroute_get_health, omniroute_check_quota",
  });
  assert.ok(profile);
  assert.equal(profile.name, "custom");
  assert.deepEqual([...(profile.allowTools ?? [])].sort(), [
    "omniroute_check_quota",
    "omniroute_get_health",
  ]);
  assert.deepEqual(announcedNames(profile).sort(), [
    "omniroute_check_quota",
    "omniroute_get_health",
  ]);
});

test("MCP_TOOL_DENY wins over the curated allow-list", () => {
  const profile = readMcpHttpToolProfile({
    MCP_TOOL_DENY: "omniroute_memory_search,omniroute_web_fetch",
  });
  assert.ok(profile);
  assert.deepEqual(profile.denyTools, ["omniroute_memory_search", "omniroute_web_fetch"]);
  const announced = announcedNames(profile);
  assert.equal(announced.length, READ_ONLY_CONTEXT_TOOL_NAMES.length - 2);
  assert.ok(!announced.includes("omniroute_memory_search"));
  assert.ok(!announced.includes("omniroute_web_fetch"));
});

test("MCP_TOOL_ALLOW=all plus MCP_TOOL_DENY keeps only the deny filter", () => {
  const profile = readMcpHttpToolProfile({
    MCP_TOOL_ALLOW: "all",
    MCP_TOOL_DENY: "omniroute_switch_combo",
  });
  assert.ok(profile);
  assert.equal(profile.name, "full");
  assert.equal(profile.allowTools, undefined);
  const announced = announcedNames(profile);
  assert.ok(!announced.includes("omniroute_switch_combo"));
  assert.ok(announced.includes("omniroute_get_health"));
});

test("tool search is scoped to the announced allow-list", () => {
  const allowed = new Set(["omniroute_memory_search", "omniroute_skills_list"]);
  const scoped = handleToolSearch({ query: "health memory skills", limit: 25 }, allowed);
  assert.ok(scoped.tools.length > 0, "expected at least one scoped hit");
  for (const hit of scoped.tools) {
    assert.ok(allowed.has(hit.name), `tool search leaked non-announced tool ${hit.name}`);
  }

  const unscoped = handleToolSearch({ query: "health", limit: 25 });
  assert.ok(
    unscoped.tools.some((hit) => hit.name === "omniroute_get_health"),
    "unscoped tool search must still cover the full catalog"
  );
  const scopedHealth = handleToolSearch(
    { query: "health", limit: 25 },
    new Set(READ_ONLY_CONTEXT_TOOL_NAMES)
  );
  assert.ok(
    !scopedHealth.tools.some((hit) => hit.name === "omniroute_get_health"),
    "curated tool search must not advertise tools the HTTP manifest disabled"
  );
});

test.after(async () => {
  const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
