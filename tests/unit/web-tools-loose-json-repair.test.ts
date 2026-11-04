// Parser repair for the two escaping mistakes web models make inside a
// `<tool_call>` block (2026-11-04).
//
// Both blocks below are captured verbatim from production gemini-web responses
// (2026-11-03T11:27Z and 12:49Z). They leaked into `content` as plain text, so
// Claude Code CLI received prose instead of a tool call on a HTTP 200 — the agent
// then stalled because no tool_use ever arrived.

import test from "node:test";
import assert from "node:assert/strict";

import { parseToolCallsFromText } from "../../open-sse/translator/webTools.ts";

const BASH_TOOL = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const TOOLS = [BASH_TOOL];

test("repairs an unescaped quote inside a tool_call argument (production 11:27Z)", () => {
  const block =
    '<tool_call>{"name": "Bash", "arguments": {"command": "cd /repo && git status -sb && grep -n "tool_call\\|tools\\|CRITICAL RULES" open-sse/executors/gemini-web.ts 2>/dev/null | head -60", "description": "Inspect gemini-web executor tool-call handling"}}</tool_call>';

  const result = parseToolCallsFromText(block, "call-quote-1", TOOLS);

  assert.equal(result.toolCalls?.length, 1, "the block must parse, not leak as prose");
  assert.equal(result.toolCalls?.[0]?.function?.name, "Bash");

  const args = JSON.parse(result.toolCalls![0]!.function!.arguments) as { command: string };
  assert.match(
    args.command,
    /grep -n "tool_call\\\|tools\\\|CRITICAL RULES"/,
    "the inner quotes must survive the repair — escaped in the JSON, intact in the value"
  );
  assert.equal(result.content.trim(), "", "nothing may be left behind in content");
});

test("repairs an unescaped quote with no space before the delimiter (production 12:49Z)", () => {
  const block =
    '<tool_call>{"name": "Bash", "arguments": {"command":"ls -la plans/ && grep -rn "TODO\\|FIXME\\|M12" src/ plans/ 2>/dev/null | head -40","description":"Check reports and search TODOs"}}</tool_call>';

  const result = parseToolCallsFromText(block, "call-quote-2", TOOLS);

  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0]?.function?.name, "Bash");

  const args = JSON.parse(result.toolCalls![0]!.function!.arguments) as { command: string };
  assert.match(args.command, /grep -rn "TODO\\\|FIXME\\\|M12"/);
});

test("leaves well-formed JSON alone", () => {
  const result = parseToolCallsFromText(
    '<tool_call>{"name":"Bash","arguments":{"command":"echo hello"}}</tool_call>',
    "call-quote-3",
    TOOLS
  );

  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0]?.function?.arguments, '{"command":"echo hello"}');
});

test("does not invent a call when the block cannot be repaired", () => {
  // An unterminated string must stay text: emitting a mangled command would run
  // the wrong shell line, which is worse than the prose it replaces.
  const result = parseToolCallsFromText(
    '<tool_call>{"name": "Bash", "arguments": {"command": "echo \\"unterminated}}</tool_call>',
    "call-quote-4",
    TOOLS
  );

  assert.equal(result.toolCalls?.length ?? 0, 0);
});

test("does not touch a valid escape such as a newline or a quote", () => {
  const result = parseToolCallsFromText(
    '<tool_call>{"name":"Bash","arguments":{"command":"printf \\"a\\\\nb\\""}}</tool_call>',
    "call-quote-5",
    TOOLS
  );

  assert.equal(result.toolCalls?.length, 1);
  const args = JSON.parse(result.toolCalls![0]!.function!.arguments) as { command: string };
  assert.equal(args.command, 'printf "a\\nb"');
});
