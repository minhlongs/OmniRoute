import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMessageContentText,
  buildGeminiToolPrompt,
  buildGeminiPrompt,
  sanitizeGeminiWebOutput,
  buildGeminiToolResponse,
} from "../../open-sse/executors/gemini-web.ts";

describe("gemini-web — extractMessageContentText", () => {
  test("extracts string content verbatim", () => {
    assert.equal(extractMessageContentText("hello world"), "hello world");
  });

  test("extracts array of text blocks", () => {
    const content = [
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ];
    assert.equal(extractMessageContentText(content), "line 1\nline 2");
  });

  test("extracts tool_use blocks into <tool_call>", () => {
    const content = [
      { type: "text", text: "Running command" },
      { type: "tool_use", name: "Bash", input: { command: "git status" } },
    ];
    const text = extractMessageContentText(content);
    assert.ok(text.includes("Running command"));
    assert.ok(text.includes('<tool_call>{"name": "Bash", "arguments": {"command":"git status"}}</tool_call>'));
  });

  test("extracts tool_result blocks", () => {
    const content = [
      { type: "tool_result", tool_use_id: "toolu_123", content: "On branch main\nnothing to commit" },
    ];
    const text = extractMessageContentText(content);
    assert.ok(text.includes("Tool [toolu_123] Result:"));
    assert.ok(text.includes("On branch main"));
  });
});

describe("gemini-web — buildGeminiToolPrompt", () => {
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute bash command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];

  test("includes critical rules suppressing /home/bard and Python sandbox", () => {
    const messages = [{ role: "user", content: "run git status" }];
    const prompt = buildGeminiToolPrompt(messages, TOOLS);
    assert.ok(prompt.includes("CRITICAL RULES"));
    assert.ok(prompt.includes("DO NOT execute code using your internal Python sandbox"));
    assert.ok(prompt.includes("Never run code in /home/bard"));
    assert.ok(prompt.includes("<tool_call>"));
    assert.ok(prompt.includes("Available tools:"));
    assert.ok(prompt.includes("- Bash: Execute bash command"));
    assert.ok(prompt.includes("run git status"));
  });

  test("handles array content in user message without losing content", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "array content user ask" }],
      },
    ];
    const prompt = buildGeminiToolPrompt(messages, TOOLS);
    assert.ok(prompt.includes("array content user ask"));
  });

  test("preserves client system instructions and multi-turn history", () => {
    const messages = [
      { role: "system", content: "You are an expert engineer." },
      { role: "user", content: "check status" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "branch main" }],
      },
      { role: "user", content: "what next?" },
    ];
    const prompt = buildGeminiToolPrompt(messages, TOOLS);
    assert.ok(prompt.includes("You are an expert engineer."));
    assert.ok(prompt.includes("Previous conversation:"));
    assert.ok(prompt.includes("check status"));
    assert.ok(prompt.includes("Tool [1] Result:"));
    assert.ok(prompt.includes("Current user message:\nwhat next?"));
  });
});

describe("gemini-web — sanitizeGeminiWebOutput", () => {
  test("recovers subprocess.run from Google Borg Python container as Bash tool call", () => {
    const rawOutput = `\`\`\`python?code_reference&code_event_index=1
import subprocess
print(subprocess.run(["git", "status"], capture_output=True, text=True).stdout)

\`\`\`

\`\`\`text?code_stdout&code_event_index=1
Traceback (most recent call last):
  File "<xbox-string>", line 2, in <module>
FileNotFoundError: [Errno 2] No such file or directory: 'git'
\`\`\`

I attempted to run git status.`;

    const sanitized = sanitizeGeminiWebOutput(rawOutput);
    assert.ok(sanitized.includes('<tool_call>{"name": "Bash", "arguments": {"command": "git status"}}</tool_call>'));
    assert.ok(!sanitized.includes("code_reference"));
    assert.ok(!sanitized.includes("code_stdout"));
    assert.ok(!sanitized.includes("Traceback"));
    assert.ok(sanitized.includes("I attempted to run git status."));
  });

  test("leaves existing tool calls untouched while stripping python artifacts", () => {
    const rawOutput = `<tool_call>{"name": "Bash", "arguments": {"command": "ls -la"}}</tool_call>
\`\`\`text?code_stdout
/home/bard output
\`\`\``;
    const sanitized = sanitizeGeminiWebOutput(rawOutput);
    assert.ok(sanitized.includes('<tool_call>{"name": "Bash", "arguments": {"command": "ls -la"}}</tool_call>'));
    assert.ok(!sanitized.includes("/home/bard output"));
  });
});

describe("gemini-web — buildGeminiToolResponse", () => {
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "Bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];

  test("non-streaming response returns OpenAI completion with tool_calls", async () => {
    const text = '<tool_call>{"name": "Bash", "arguments": {"command": "pwd"}}</tool_call>';
    const resp = await buildGeminiToolResponse(text, TOOLS, false, "gemini-4-argon", "cid-1", 12345);
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "Bash");
    assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), { command: "pwd" });
  });

  test("streaming response returns SSE stream with tool_calls chunk", async () => {
    const text = '<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>';
    const resp = await buildGeminiToolResponse(text, TOOLS, true, "gemini-4-argon", "cid-1", 12345);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.ok(body.includes('"finish_reason":"tool_calls"'));
    assert.ok(body.includes('"name":"Bash"'));
    assert.ok(body.includes('data: [DONE]'));
  });
});
