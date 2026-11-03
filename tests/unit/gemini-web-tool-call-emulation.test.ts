import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiToolPrompt,
  buildGeminiToolResponse,
} from "../../open-sse/executors/gemini-web.ts";
import { parseToolCallsFromText } from "../../open-sse/translator/webTools.ts";

describe("Gemini Web Tool Call Emulation", () => {
  const sampleTools = [
    {
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
    },
  ];

  it("builds tool prompt with anti-Python container rules, client system prompt, and tools list", () => {
    const messages = [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI." },
      {
        role: "user",
        content: [{ type: "text", text: "Run echo 123" }],
      },
    ];

    const prompt = buildGeminiToolPrompt(messages, sampleTools);

    assert.ok(prompt.includes("CRITICAL RULES:"), "Should include critical rules");
    assert.ok(
      prompt.includes("DO NOT execute code using your internal Python sandbox"),
      "Should forbid internal Python"
    );
    assert.ok(prompt.includes("/home/bard"), "Should mention /home/bard");
    assert.ok(prompt.includes("<tool_call>"), "Should instruct <tool_call>");
    assert.ok(prompt.includes("You are Claude Code"), "Should preserve client system prompt");
    assert.ok(prompt.includes("Bash: Run a shell command"), "Should list available tools");
    assert.ok(
      prompt.includes("Run echo 123"),
      "Should include user request text from array content"
    );
  });

  it("preserves multi-turn conversation history and tool results in prompt", () => {
    const messages = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Check git status" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "Bash", arguments: '{"command":"git status"}' } }],
      },
      {
        role: "tool",
        content: "On branch main\nnothing to commit",
      },
      { role: "user", content: "Now list files" },
    ];

    const prompt = buildGeminiToolPrompt(messages, sampleTools);

    assert.ok(prompt.includes("Previous conversation:"), "Should include conversation history");
    assert.ok(prompt.includes("Check git status"), "Should include turn 1 user");
    assert.ok(prompt.includes("tool_call"), "Should include turn 2 assistant tool call");
    assert.ok(prompt.includes("Tool Result: On branch main"), "Should include turn 3 tool result");
    assert.ok(prompt.includes("Now list files"), "Should include current turn user");
  });

  it("parses <tool_call> tags and extracts tool calls", () => {
    const text =
      'I will run the command:\n<tool_call>{"name":"Bash","arguments":{"command":"echo hello"}}</tool_call>';
    const result = parseToolCallsFromText(text, "call-1", sampleTools);

    assert.ok(result.toolCalls, "Should parse tool calls");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.function?.name, "Bash");
    assert.equal(result.toolCalls?.[0]?.function?.arguments, '{"command":"echo hello"}');
    assert.equal(result.content, "I will run the command:");
  });

  it("parses <tool_call name='Bash'> with direct command JSON", () => {
    const text = '<tool_call name="Bash">{"command":"ls -la"}</tool_call>';
    const result = parseToolCallsFromText(text, "call-2", sampleTools);

    assert.ok(result.toolCalls, "Should parse tool calls");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.function?.name, "Bash");
    assert.equal(result.toolCalls?.[0]?.function?.arguments, '{"command":"ls -la"}');
  });

  it("parses a bare <tool_call> command object with no name field", () => {
    // Observed live from Claude Code CLI traffic (2026-11-03): gemini-web answers
    // with the ARGUMENTS only — `<tool_call>{"command": "...", "description": "..."}</tool_call>`
    // — no `name`, no `name=""` attribute. Without a fallback the block cannot be
    // named, so it was left in `content` and the CLI received prose instead of a
    // tool call. The only requested tool that takes a `command` is Bash here.
    const text =
      '<tool_call>{"command": "git status", "description": "Show working tree status"}</tool_call>';
    const result = parseToolCallsFromText(text, "call-bare", sampleTools);

    assert.ok(result.toolCalls, "a bare command object must still become a tool call");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.function?.name, "Bash");
    assert.deepEqual(JSON.parse(result.toolCalls![0]!.function!.arguments), {
      command: "git status",
      description: "Show working tree status",
    });
    assert.equal(result.content.trim(), "", "the block must be consumed, not leaked as text");
  });

  it("does not invent a command tool when none was offered", () => {
    // Same shape, but the request asked for a web tool. Guessing "Bash" here would
    // emit a tool call the client cannot execute, so the block stays text.
    const webTools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const result = parseToolCallsFromText(
      '<tool_call>{"command": "git status"}</tool_call>',
      "call-bare-2",
      webTools
    );
    assert.equal(result.toolCalls?.length ?? 0, 0);
  });

  it("cleans internal Borg / Python execution artifacts from response text", () => {
    const text =
      'Here is the result:\ntext?code_stdout=123\npython?code_reference=456\n<tool_call>{"name":"Bash","arguments":{"command":"pwd"}}</tool_call>';
    const result = parseToolCallsFromText(text, "call-3", sampleTools);

    assert.ok(result.toolCalls, "Should parse tool calls");
    assert.ok(!result.content.includes("code_stdout"), "Should strip code_stdout");
    assert.ok(!result.content.includes("code_reference"), "Should strip code_reference");
  });

  it("buildGeminiToolResponse formats valid response for streaming and non-streaming", async () => {
    const responseText =
      '<tool_call>{"name":"Bash","arguments":{"command":"uname -a"}}</tool_call>';

    // Non-streaming
    const nonStreamResp = await buildGeminiToolResponse(
      responseText,
      sampleTools,
      false,
      "gemini-4-argon",
      "cid-1",
      1234567890
    );
    assert.equal(nonStreamResp.status, 200);
    const nonStreamJson = await nonStreamResp.json();
    assert.equal(nonStreamJson.choices[0].finish_reason, "tool_calls");
    assert.equal(nonStreamJson.choices[0].message.tool_calls[0].function.name, "Bash");

    // Streaming
    const streamResp = await buildGeminiToolResponse(
      responseText,
      sampleTools,
      true,
      "gemini-4-argon",
      "cid-2",
      1234567890
    );
    assert.equal(streamResp.status, 200);
    const streamText = await streamResp.text();
    assert.ok(streamText.includes('"tool_calls"'), "SSE stream should contain tool_calls");
    assert.ok(streamText.includes("data: [DONE]"), "SSE stream should end with [DONE]");
  });
});
