import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { openaiToOpenAIResponsesRequest } = await import(
  "../../open-sse/translator/request/openai-responses/toResponses.ts"
);
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { NON_ANTHROPIC_THINKING_PLACEHOLDER } = await import(
  "../../open-sse/utils/reasoningPlaceholder.ts"
);

test("openaiToOpenAIResponsesRequest injects reasoning placeholder for DeepSeek thinking model when assistant lacks reasoning", () => {
  const openAiBody = {
    model: "deepseek/deepseek-flash",
    messages: [
      { role: "user", content: "run tool" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "tool_1", content: "file1.txt" },
    ],
  };

  const res = openaiToOpenAIResponsesRequest("deepseek/deepseek-flash", openAiBody, false, {}) as {
    input: Record<string, unknown>[];
  };

  assert.ok(Array.isArray(res.input), "input must be an array");

  const reasoningIdx = res.input.findIndex((item) => item.type === "reasoning");
  const funcCallIdx = res.input.findIndex((item) => item.type === "function_call");

  assert.ok(reasoningIdx !== -1, "Must contain a reasoning item");
  assert.ok(funcCallIdx !== -1, "Must contain a function_call item");
  assert.ok(reasoningIdx < funcCallIdx, "Reasoning item must precede function_call");

  const reasoningItem = res.input[reasoningIdx];
  assert.deepEqual(reasoningItem.summary, []);
  assert.deepEqual(reasoningItem.content, [
    { type: "reasoning_text", text: NON_ANTHROPIC_THINKING_PLACEHOLDER },
  ]);
});

test("translateRequest from Claude format to OpenAI Responses format preserves reasoning placeholder for DeepSeek", () => {
  const claudeBody = {
    model: "deepseek/deepseek-flash",
    messages: [
      { role: "user", content: "Run tool" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "execute",
            input: { cmd: "date" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: "Tue Nov 3",
          },
        ],
      },
    ],
  };

  const res = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI_RESPONSES,
    "deepseek/deepseek-flash",
    claudeBody,
    false,
    null,
    "deepseek"
  ) as { input: Record<string, unknown>[] };

  assert.ok(Array.isArray(res.input), "res.input must be an array");

  const reasoningItem = res.input.find((item) => item.type === "reasoning");
  assert.ok(reasoningItem, "Reasoning item must survive translateRequest and applyReasoningInputPolicy");
  assert.deepEqual((reasoningItem as Record<string, unknown>).content, [
    { type: "reasoning_text", text: NON_ANTHROPIC_THINKING_PLACEHOLDER },
  ]);
});

test("translateRequest preserves authentic reasoning when present", () => {
  const openAiBody = {
    model: "deepseek/deepseek-flash",
    messages: [
      { role: "user", content: "Think first" },
      {
        role: "assistant",
        reasoning_content: "My authentic chain of thought",
        content: "Here is the answer",
      },
      { role: "user", content: "Next question" },
    ],
  };

  const res = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI_RESPONSES,
    "deepseek/deepseek-flash",
    openAiBody,
    false,
    null,
    "deepseek"
  ) as { input: Record<string, unknown>[] };

  const reasoningItem = res.input.find((item) => item.type === "reasoning");
  assert.ok(reasoningItem, "Reasoning item must be present");
  assert.deepEqual((reasoningItem as Record<string, unknown>).content, [
    { type: "reasoning_text", text: "My authentic chain of thought" },
  ]);
});
