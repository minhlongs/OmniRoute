// Tool calling for the Gemini Web executor (#7286) — Level 2 of the staged
// approach in the issue: wire the existing `webTools.ts` prompt-emulation
// shim (already proven across 11 other web-cookie executors) into
// gemini-web.ts. claude-web (Level 3) is explicitly out of scope.
//
// gemini-web buffers the *entire* Gemini response before returning (it has
// no true token-by-token streaming — see the executor's docblock), so the
// tool-call decision is made once on the full text, then replayed either as
// a buffered JSON completion or a single terminal SSE chunk.

import test from "node:test";
import assert from "node:assert/strict";

const { GeminiWebExecutor, buildGeminiToolResponse, buildGeminiToolPrompt } =
  await import("../../open-sse/executors/gemini-web.ts");

interface ToolCallLike {
  function: { name: string; arguments: string };
}

interface ChatCompletionLike {
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCallLike[] };
    finish_reason: string;
  }>;
}

interface StreamChunkLike {
  choices: Array<{
    delta: { role?: string; content?: string; tool_calls?: ToolCallLike[] };
    finish_reason: string | null;
  }>;
}

const GET_WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

// ─── Pure-function tests: buildGeminiToolResponse ───────────────────────────
// (the branching/parsing logic extracted out of the tool-mode path so it is
// directly testable without a full Playwright mock)

test("#7286: well-formed tool call → tool_calls, content:null, finish_reason:tool_calls (non-streaming)", async () => {
  const responseText =
    'Sure, let me check.\n<tool>{"name":"get_weather","arguments":{"city":"Paris"}}</tool>';

  const response = await buildGeminiToolResponse(
    responseText,
    [GET_WEATHER_TOOL],
    false,
    "gemini-3.1-pro",
    "chatcmpl-gwe-test",
    1700000000
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as ChatCompletionLike;
  const choice = json.choices[0];
  assert.equal(choice.message.content, null);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), {
    city: "Paris",
  });
});

test("#7286: malformed <tool> JSON degrades to ordinary chat content — never throws, never a 500", async () => {
  const responseText = "Here's what I found: <tool>{not valid json</tool>";

  const response = await buildGeminiToolResponse(
    responseText,
    [GET_WEATHER_TOOL],
    false,
    "gemini-3.1-pro",
    "chatcmpl-gwe-test",
    1700000000
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as ChatCompletionLike;
  const choice = json.choices[0];
  assert.equal(choice.finish_reason, "stop");
  assert.equal(choice.message.tool_calls, undefined);
  assert.ok(typeof choice.message.content === "string" && choice.message.content.length > 0);
});

test("#7286: streaming assembly — role chunk, then terminal chunk with delta.tool_calls, then [DONE]", async () => {
  const responseText = '<tool>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool>';

  const response = await buildGeminiToolResponse(
    responseText,
    [GET_WEATHER_TOOL],
    true,
    "gemini-3.1-pro",
    "chatcmpl-gwe-test",
    1700000000
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const bodyText = await response.text();
  const dataLines = bodyText
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length));

  assert.equal(dataLines[dataLines.length - 1], "[DONE]");
  const parsed: StreamChunkLike[] = dataLines
    .slice(0, -1)
    .map((line) => JSON.parse(line) as StreamChunkLike);
  assert.equal(parsed.length, 2, "expected a role chunk + one terminal chunk");
  assert.deepEqual(parsed[0].choices[0].delta, { role: "assistant" });
  assert.equal(parsed[0].choices[0].finish_reason, null);

  const terminal = parsed[1];
  assert.equal(terminal.choices[0].finish_reason, "tool_calls");
  assert.equal(terminal.choices[0].delta.tool_calls?.length, 1);
  assert.equal(terminal.choices[0].delta.tool_calls?.[0].function.name, "get_weather");
});

test("#7286: no <tool> block and no requested tools → toolCalls untouched (plain content passthrough)", async () => {
  const response = await buildGeminiToolResponse(
    "Just a normal answer, nothing to call.",
    [GET_WEATHER_TOOL],
    false,
    "gemini-3.1-pro",
    "chatcmpl-gwe-test",
    1700000000
  );

  const json = (await response.json()) as ChatCompletionLike;
  const choice = json.choices[0];
  assert.equal(choice.finish_reason, "stop");
  assert.equal(choice.message.tool_calls, undefined);
  assert.equal(choice.message.content, "Just a normal answer, nothing to call.");
});

// ─── buildGeminiToolPrompt ───────────────────────────────────────────────────

test("#7286: buildGeminiToolPrompt concatenates the synthetic tool system prompt + last user message", () => {
  const effectiveMessages = [
    { role: "system", content: "TOOL CONTRACT HERE" },
    { role: "user", content: "what's the weather in Paris?" },
  ];
  const prompt = buildGeminiToolPrompt(effectiveMessages);
  // Contract tail placement (2026-11-04): the contract must be the LAST thing the
  // model reads, because on 200-300K prompts it previously sat at 21.7% offset and
  // the tool-call rate dropped to 57%.
  assert.equal(prompt, "what's the weather in Paris?\n\nTOOL CONTRACT HERE");
});

test("#7286: buildGeminiToolPrompt falls back to the user text alone when there is no system message", () => {
  const effectiveMessages = [{ role: "user", content: "hello" }];
  assert.equal(buildGeminiToolPrompt(effectiveMessages), "hello");
});

test("#7286: buildGeminiToolPrompt keeps the injected trailing contract and the conversation history", () => {
  // prepareToolMessages() pushes the contract as the LAST system message; a real
  // client (Claude Code) also sends its own system prompt first and a multi-turn
  // history. Dropping either leaves the model without the <tool> contract and
  // without context, so it answers conversationally instead of calling tools.
  const effectiveMessages = [
    { role: "system", content: "You are Claude Code." },
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "file contents" },
    { role: "user", content: "now fix the bug" },
    { role: "system", content: "TOOL CONTRACT: reply with <tool>{...}</tool>" },
  ];
  const prompt = buildGeminiToolPrompt(effectiveMessages);
  assert.ok(prompt.includes("TOOL CONTRACT"), "injected tool contract must survive");
  assert.ok(prompt.includes("read a.ts"), "prior user turn must survive");
  assert.ok(prompt.includes("file contents"), "prior assistant turn must survive");
  assert.ok(prompt.includes("now fix the bug"), "current user message must survive");
});

test("#7286: buildGeminiToolPrompt prefers the last system message as the tool contract", () => {
  const effectiveMessages = [
    { role: "system", content: "CLIENT SYSTEM PROMPT" },
    { role: "user", content: "do it" },
    { role: "system", content: "INJECTED TOOL CONTRACT" },
  ];
  const prompt = buildGeminiToolPrompt(effectiveMessages);
  assert.ok(prompt.endsWith("INJECTED TOOL CONTRACT"), "contract must end the prompt");
  assert.ok(prompt.includes("CLIENT SYSTEM PROMPT"), "client system prompt must not be lost");
});

// ─── Full executor integration (Playwright mocked) ──────────────────────────
//
// Mirrors the mocking pattern already used in tests/unit/gemini-web.test.ts
// ("Normalizes a bare __Secure-1PSID value..."): fake out `chromium.launch`
// so `execute()` runs the real request/response wiring — including
// `prepareToolMessages` → prompt construction → `parseStreamResponse` →
// `buildGeminiToolResponse` — end to end, proving the tool-mode wiring
// actually reaches the Playwright-driven code path (not just the extracted
// pure function).

function makeStreamGenerateChunk(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
}

function makeStreamGenerateRaw(text: string): string {
  return `)]}'\n10\n${makeStreamGenerateChunk(text)}`;
}

interface FakePlaywrightResponse {
  url: () => string;
  text: () => Promise<string>;
}

type FakeResponseHandler = (resp: FakePlaywrightResponse) => Promise<void>;

async function withMockedGeminiBrowser<T>(
  responseText: string,
  fn: (typedPrompt: { value: string }) => Promise<T>
): Promise<T> {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const typedPrompt = { value: "" };

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => {
        let respHandler: FakeResponseHandler | null = null;
        const page = {
          on: (event: string, cb: FakeResponseHandler) => {
            if (event === "response") respHandler = cb;
          },
          goto: async () => {},
          waitForTimeout: async () => {},
          waitForSelector: async () => ({ click: async () => {} }),
          keyboard: {
            type: async (text: string) => {
              typedPrompt.value = text;
            },
            press: async () => {
              if (respHandler) {
                await respHandler({
                  url: () => "https://gemini.google.com/_/BardChatUi/data/.../StreamGenerate?x",
                  text: async () => makeStreamGenerateRaw(responseText),
                });
              }
            },
          },
        };
        return page;
      },
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    return await fn(typedPrompt);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
}

test("#7286: executor integration — tools[] present reaches tool_calls end to end", async () => {
  const responseText = '<tool>{"name":"get_weather","arguments":{"city":"Berlin"}}</tool>';

  await withMockedGeminiBrowser(responseText, async () => {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: {
        messages: [{ role: "user", content: "what's the weather in Berlin?" }],
        stream: false,
        tools: [GET_WEATHER_TOOL],
      },
      stream: false,
      credentials: { apiKey: "test-cookie" },
      signal: AbortSignal.timeout(10000),
      log: null,
    });

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as ChatCompletionLike;
    const choice = json.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.tool_calls?.[0].function.name, "get_weather");
  });
});

test("#7286: no-tool passthrough regression — unchanged prompt derivation + response shape when tools absent", async () => {
  await withMockedGeminiBrowser("Just chatting, no tools here.", async (typedPrompt) => {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: {
        messages: [{ role: "user", content: "hello there" }],
        stream: false,
      },
      stream: false,
      credentials: { apiKey: "test-cookie" },
      signal: AbortSignal.timeout(10000),
      log: null,
    });

    // Old behavior: the prompt typed into the UI is exactly the last user
    // message — no tool contract prepended.
    assert.equal(typedPrompt.value, "hello there");

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as ChatCompletionLike;
    const choice = json.choices[0];
    assert.equal(choice.message.content, "Just chatting, no tools here.");
    assert.equal(choice.message.tool_calls, undefined);
    assert.equal(choice.finish_reason, "stop");
  });
});
