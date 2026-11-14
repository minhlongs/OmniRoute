import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end check of the HTTP MCP manifest a Claude Code client receives over the real
// Streamable HTTP transport (`/api/mcp/stream` handler): the curated READ-ONLY profile is the
// default, and `MCP_TOOL_ALLOW=all` restores the full catalog.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mcp-http-manifest-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
delete process.env.MCP_TOOL_ALLOW;
delete process.env.MCP_TOOL_DENY;

const transport = await import("../../../open-sse/mcp-server/httpTransport.ts");
const { READ_ONLY_CONTEXT_TOOL_NAMES } =
  await import("../../../open-sse/mcp-server/readOnlyToolProfile.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type ToolsListResult = { tools: Array<{ name: string }> };
type ToolCallResult = { content?: Array<{ type: string; text?: string }> };

const INIT_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "claude-code-manifest-test", version: "1.0.0" },
};

function makeRequest(body: unknown, sessionId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Request("http://localhost/api/mcp/stream", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readJsonRpc(response: Response): Promise<JsonRpcEnvelope> {
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  assert.ok(dataLine, `expected an SSE data event, got: ${text.slice(0, 300)}`);
  return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcEnvelope;
}

async function initializeSession(): Promise<string> {
  const response = await transport.handleMcpStreamableHTTP(
    makeRequest({ jsonrpc: "2.0", method: "initialize", id: 1, params: INIT_PARAMS })
  );
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize must return an Mcp-Session-Id header");
  return sessionId;
}

async function listToolNames(sessionId: string): Promise<string[]> {
  const response = await transport.handleMcpStreamableHTTP(
    makeRequest({ jsonrpc: "2.0", method: "tools/list", id: 2 }, sessionId)
  );
  assert.equal(response.status, 200);
  const envelope = await readJsonRpc(response);
  assert.ok(envelope.result, `tools/list failed: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result as ToolsListResult;
  return result.tools.map((tool) => tool.name).sort();
}

test("the HTTP transport announces the curated read-only profile by default", async () => {
  transport.shutdownMcpHttp();
  const sessionId = await initializeSession();

  const names = await listToolNames(sessionId);
  assert.deepEqual(names, [...READ_ONLY_CONTEXT_TOOL_NAMES].sort());
  assert.equal(names.length, 13);
  assert.ok(!names.includes("omniroute_switch_combo"), "no write tool may be announced");
  assert.ok(!names.includes("omniroute_memory_add"), "no write tool may be announced");
  assert.ok(
    !names.includes("omniroute_route_request"),
    "no execute-completion tool may be announced"
  );

  transport.shutdownMcpHttp();
});

test("tool search over the curated transport cannot advertise a disabled tool", async () => {
  transport.shutdownMcpHttp();
  const sessionId = await initializeSession();

  const response = await transport.handleMcpStreamableHTTP(
    makeRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 3,
        params: {
          name: "omniroute_tool_search",
          arguments: { query: "health memory skills", limit: 25 },
        },
      },
      sessionId
    )
  );
  assert.equal(response.status, 200);
  const envelope = await readJsonRpc(response);
  assert.ok(envelope.result, `tools/call failed: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result as ToolCallResult;
  const text = result.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text) as { tools: Array<{ name: string }> };
  assert.ok(parsed.tools.length > 0);
  for (const hit of parsed.tools) {
    assert.ok(
      READ_ONLY_CONTEXT_TOOL_NAMES.includes(hit.name),
      `tool search advertised ${hit.name}, which is not in the curated HTTP manifest`
    );
  }

  transport.shutdownMcpHttp();
});

test("MCP_TOOL_ALLOW=all restores the full catalog over HTTP", async () => {
  transport.shutdownMcpHttp();
  process.env.MCP_TOOL_ALLOW = "all";
  try {
    const sessionId = await initializeSession();
    const names = await listToolNames(sessionId);
    assert.equal(names.length, 110);
    assert.ok(names.includes("omniroute_switch_combo"));
    assert.ok(names.includes("omniroute_get_health"));
  } finally {
    delete process.env.MCP_TOOL_ALLOW;
    transport.shutdownMcpHttp();
  }
});

test("the SSE HTTP transport shares the curated read-only profile by default", async () => {
  transport.shutdownMcpHttp();
  const initResponse = await transport.handleMcpSSE(
    new Request("http://localhost/api/mcp/sse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 10, params: INIT_PARAMS }),
    })
  );
  assert.equal(initResponse.status, 200);
  const sseSessionId = initResponse.headers.get("mcp-session-id");
  assert.ok(sseSessionId, "SSE initialize must return an Mcp-Session-Id header");

  const listHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-session-id": sseSessionId,
  };
  const listResponse = await transport.handleMcpSSE(
    new Request("http://localhost/api/mcp/sse", {
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 11 }),
    })
  );
  assert.equal(listResponse.status, 200);
  const envelope = await readJsonRpc(listResponse);
  const result = envelope.result as ToolsListResult;
  const names = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...READ_ONLY_CONTEXT_TOOL_NAMES].sort());
  assert.equal(names.length, 13);

  transport.shutdownMcpHttp();
});

test.after(() => {
  transport.shutdownMcpHttp();
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
