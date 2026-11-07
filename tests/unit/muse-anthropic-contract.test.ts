import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest } from "@omniroute/open-sse/translator/index.ts";
import { FORMATS } from "@omniroute/open-sse/translator/formats.ts";

// A Claude Code shaped turn: user prompt, assistant text + tool_use, user tool_result.
function claudeBody() {
  return {
    model: "muse-web",
    max_tokens: 512,
    stream: true,
    system: "You can call the tools below. Reply with tool_calls.",
    messages: [
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running the command" },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "a.txt\nb.txt" }],
      },
    ],
    tools: [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
  };
}

test("claude -> openai for muse-web keeps the conversation shape", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "muse-web",
    claudeBody(),
    true,
    null,
    "muse-web"
  );

  assert.equal(out.model, "muse-web");
  assert.ok(Array.isArray(out.messages));
  assert.ok(out.messages.length >= 3, "system + user + assistant + tool result must survive");
});

test("claude -> openai for muse-web preserves the tool contract", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "muse-web",
    claudeBody(),
    true,
    null,
    "muse-web"
  );

  assert.ok(Array.isArray(out.tools) && out.tools.length === 1);
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "Bash");

  const assistantWithCalls = out.messages.some(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
  );
  const toolResult = out.messages.some((message) => message.role === "tool");
  assert.ok(assistantWithCalls, "assistant tool_calls must be reconstructed");
  assert.ok(toolResult, "tool_result must become a tool message");
});

test("claude -> openai keeps the muse official provider routable", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "muse-spark-1.3",
    { ...claudeBody(), model: "muse-spark-1.3" },
    false,
    null,
    "muse"
  );

  assert.equal(out.model, "muse-spark-1.3");
  assert.ok(out.messages.length >= 3);
});
