// Retry-with-nudge for gemini-web tool calling (2026-11-04).
//
// gemini-web has no native function calling: the tool contract is prompt text and
// the `<tool_call>` block is parsed back out. On the real Claude Code CLI payloads
// we replay, ~25% of turns come back as prose ("the web chat interface only
// returns text") with `tool_calls: []`, so the agent stalls on a 200.
//
// These tests pin the DECISION and the WRAPPER wiring, both without a browser:
// the decision is what regresses silently, and the wrapper is where the first
// version of this feature failed (it logged at `info`, which the runtime level
// dropped, so zero firings were visible while prose was common).

import test from "node:test";
import assert from "node:assert/strict";

const {
  shouldRetryGeminiWebToolCall,
  GEMINI_WEB_FORCED_TOOL_NUDGE,
  GEMINI_WEB_TOOL_RETRY_BUDGET_MS,
  GeminiWebExecutor,
} = await import("../../open-sse/executors/gemini-web.ts");

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

const PROSE_BODY = JSON.stringify({
  id: "chatcmpl-x",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "Giao diện chat web chỉ trả về text." },
    },
  ],
});

const TOOL_BODY = JSON.stringify({
  id: "chatcmpl-x",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ],
      },
    },
  ],
});

test("retries when tools were offered but the reply carries no tool call", () => {
  assert.equal(
    shouldRetryGeminiWebToolCall({ body: { tools: [BASH_TOOL] } }, 200, PROSE_BODY),
    true,
    "a prose answer to a tool request is exactly the case the retry exists for"
  );
});

test("does not retry when the reply already called a tool", () => {
  assert.equal(
    shouldRetryGeminiWebToolCall({ body: { tools: [BASH_TOOL] } }, 200, TOOL_BODY),
    false
  );
});

test("does not retry when the caller offered no tools", () => {
  assert.equal(
    shouldRetryGeminiWebToolCall({ body: { messages: [] } }, 200, PROSE_BODY),
    false,
    "plain chat answers are prose by design — retrying would double every request"
  );
  assert.equal(shouldRetryGeminiWebToolCall({ body: { tools: [] } }, 200, PROSE_BODY), false);
});

test("does not retry an error response", () => {
  for (const status of [400, 401, 429, 500, 502, 503, 504]) {
    assert.equal(
      shouldRetryGeminiWebToolCall(
        { body: { tools: [BASH_TOOL] }, geminiWebToolNudge: false },
        status,
        PROSE_BODY
      ),
      false,
      `status ${status} would be the same failure twice`
    );
  }
});

test("retries at most once", () => {
  assert.equal(
    shouldRetryGeminiWebToolCall(
      { body: { tools: [BASH_TOOL] }, geminiWebToolNudge: true },
      200,
      PROSE_BODY
    ),
    false,
    "the retry marker must make the decision terminal, or a stubborn model loops"
  );
});

test("does not retry an empty body", () => {
  assert.equal(shouldRetryGeminiWebToolCall({ body: { tools: [BASH_TOOL] } }, 200, ""), false);
});

test("does not retry a first pass that already ate the budget", () => {
  // A retry on top of a slow turn would overrun the 120s combo target and replace
  // a readable prose answer with a hard timeout.
  assert.equal(
    shouldRetryGeminiWebToolCall(
      { body: { tools: [BASH_TOOL] } },
      200,
      PROSE_BODY,
      GEMINI_WEB_TOOL_RETRY_BUDGET_MS + 1
    ),
    false
  );
  assert.equal(
    shouldRetryGeminiWebToolCall(
      { body: { tools: [BASH_TOOL] } },
      200,
      PROSE_BODY,
      GEMINI_WEB_TOOL_RETRY_BUDGET_MS
    ),
    true,
    "landing exactly on the budget is still allowed"
  );
});

test("the budget covers the measured turn latency", () => {
  // Turns measure 7-9s p50 after the contract moved to the tail; a 45s budget was
  // already survivable but 60s leaves room for a slow account without approaching
  // the 120s combo target (60 + 60 = 120).
  assert.ok(GEMINI_WEB_TOOL_RETRY_BUDGET_MS >= 60_000);
});

test("the nudge tells the model to act, not to explain", () => {
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /STOP/);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /<tool_call>/);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /NOT a valid reason to refuse/i);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /nothing else/);
});

// ─── Wrapper wiring (no browser) ────────────────────────────────────────────

type InnerPass = (input: { geminiWebToolNudge?: boolean }) => Promise<{
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
}>;

function stubInner(executor: unknown, replies: string[]): boolean[] {
  const seen: boolean[] = [];
  let index = 0;
  (executor as { executeOnce: InnerPass }).executeOnce = async (inner) => {
    seen.push(Boolean(inner.geminiWebToolNudge));
    const text = replies[Math.min(index++, replies.length - 1)];
    return {
      response: new Response(text, { status: 200, headers: { "Content-Type": "application/json" } }),
      url: "https://gemini.google.com/app",
      headers: {},
      transformedBody: null,
    };
  };
  return seen;
}

const TOOL_INPUT = {
  model: "gemini-4-argon",
  body: { messages: [{ role: "user", content: "run ls" }], tools: [BASH_TOOL] },
  stream: false,
  credentials: { apiKey: "cookie" },
  signal: AbortSignal.timeout(10_000),
  log: null,
};

test("execute() runs a second pass with the nudge when the first reply is prose", async () => {
  const executor = new GeminiWebExecutor();
  const seen = stubInner(executor, [PROSE_BODY, TOOL_BODY]);

  const result = await executor.execute(TOOL_INPUT as never);

  assert.deepEqual(seen, [false, true], "one plain pass, then one nudged pass");
  assert.match(await result.response.text(), /tool_calls/);
});

test("execute() returns the first reply when it already carries a tool call", async () => {
  const executor = new GeminiWebExecutor();
  const seen = stubInner(executor, [TOOL_BODY]);

  await executor.execute(TOOL_INPUT as never);

  assert.deepEqual(seen, [false], "a good first reply must not cost a second upstream turn");
});

test("execute() gives up after the nudged pass instead of looping", async () => {
  const executor = new GeminiWebExecutor();
  const seen = stubInner(executor, [PROSE_BODY, PROSE_BODY]);

  const result = await executor.execute(TOOL_INPUT as never);

  assert.deepEqual(seen, [false, true], "exactly two passes, never three");
  assert.match(await result.response.text(), /Giao diện chat web/);
});
