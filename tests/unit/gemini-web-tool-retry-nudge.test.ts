// Retry-with-nudge for gemini-web tool calling (2026-11-03).
//
// Measured on four independent gemini-web accounts against the same real Claude
// Code CLI payloads: ~1/3 of turns come back as prose ("the web chat interface
// only returns text") with `tool_calls: []`. Prompt emulation cannot force the
// model, so the executor runs the request once more with a blunt reminder. These
// tests pin the DECISION, which is the part that can regress silently — the
// browser path itself is covered by the existing executor suites.

import test from "node:test";
import assert from "node:assert/strict";

const {
  shouldRetryGeminiWebToolCall,
  GEMINI_WEB_FORCED_TOOL_NUDGE,
  GEMINI_WEB_TOOL_RETRY_BUDGET_MS,
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
  for (const status of [400, 401, 429, 500, 502, 503]) {
    assert.equal(
      shouldRetryGeminiWebToolCall(
        { body: { tools: [BASH_TOOL] }, geminiWebToolNudge: false },
        status,
        PROSE_BODY
      ),
      false,
      `status ${status} is the same failure a second time — never burn a second upstream attempt`
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
    "the retry marker must make the decision terminal, or a stubborn model loops forever"
  );
});

test("does not retry an empty body", () => {
  assert.equal(shouldRetryGeminiWebToolCall({ body: { tools: [BASH_TOOL] } }, 200, ""), false);
});

test("does not retry a first pass that already ate the target budget", () => {
  // Measured first passes of 52s and 101s: a retry on top would exceed the 120s
  // combo target and turn a prose answer into a hard timeout.
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

test("the nudge tells the model to act, not to explain", () => {
  // The observed refusal text is an explanation of the interface. The reminder
  // must forbid exactly that and demand a tool block — vaguely "trying harder"
  // would reproduce the same answer.
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /STOP/);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /<tool_call>/);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /Do not apologise/i);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /NOT a valid reason to refuse/i);
  assert.match(GEMINI_WEB_FORCED_TOOL_NUDGE, /nothing else/);
});

// ─── Wrapper wiring (no browser) ────────────────────────────────────────────

const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");

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
      response: new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
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
