/**
 * Regression: OpenAI → Claude streaming usage for spec-compliant upstreams.
 *
 * OmniRoute requests `stream_options.include_usage: true` for OpenAI-format streaming
 * upstreams (open-sse/executors/default.ts). The OpenAI spec then emits the usage in a
 * TRAILING chunk whose `choices` is `[]`, AFTER the finish_reason chunk. The
 * OpenAI → Claude translator used to return null for every `choices: []` chunk AND to
 * emit `message_delta`/`message_stop` as soon as the finish_reason chunk arrived, so the
 * late usage was silently dropped from the client stream while call_logs (which read the
 * accumulated state at flush) still showed it. Claude Code then recorded
 * `input_tokens: 0` / no `cache_read_input_tokens`, and upstream
 * `prompt_tokens_details.cached_tokens` never reached the client.
 *
 * The fix mirrors the #6906 `awaitingTrailingUsage` pattern already shipped for the
 * Responses target (open-sse/translator/response/openai-responses.ts): when the finish
 * chunk carries no usage, defer the terminal `message_delta`/`message_stop` until the
 * trailing usage chunk arrives — or until the stream flush, so a non-compliant upstream
 * that never sends usage can never leave the client without a terminator.
 *
 * Truthfulness contract: OpenAI implicit prefix caching reports ONLY a cache-read
 * counter (`cached_tokens`). It has no cache-write accounting, so
 * `cache_creation_input_tokens` must never be fabricated — it is only emitted when the
 * upstream itself reports a positive cache-creation counter.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeResponse } =
  await import("../../open-sse/translator/response/openai-to-claude.ts");

function createState() {
  return {
    toolCalls: new Map(),
    _pendingXmlToolCalls: [],
    _xmlInvokeBuffer: "",
  };
}

function flatten(items: unknown[]): Array<Record<string, unknown>> {
  return items.flatMap((item) => (item as Array<Record<string, unknown>> | null) ?? []);
}

function contentChunk(id = "chatcmpl-1") {
  return {
    id,
    model: "zunef/claude-sonnet-4-5",
    choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
  };
}

function finishChunk(id = "chatcmpl-1", usage?: Record<string, unknown>) {
  return {
    id,
    model: "zunef/claude-sonnet-4-5",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  };
}

function trailingUsageChunk(id = "chatcmpl-1", usage?: Record<string, unknown>) {
  return {
    id,
    model: "zunef/claude-sonnet-4-5",
    choices: [],
    usage: usage ?? {
      prompt_tokens: 120000,
      completion_tokens: 500,
      total_tokens: 120500,
      // OpenAI implicit-cache counter only — no cache-creation field exists upstream.
      prompt_tokens_details: { cached_tokens: 110000 },
    },
  };
}

describe("OpenAI → Claude streaming: trailing usage-only chunk", () => {
  test("defers message_delta until the trailing usage chunk carries cached_tokens", () => {
    const state = createState();

    const content = flatten(openaiToClaudeResponse(contentChunk(), state) as unknown[]);
    assert.equal(content[0]?.type, "message_start");
    assert.equal(content[1]?.type, "content_block_start");
    assert.equal(content[2]?.delta?.text, "Hello");

    // finish_reason without usage: structural close only, terminal events deferred.
    const finish = flatten(openaiToClaudeResponse(finishChunk(), state) as unknown[]);
    assert.equal(
      finish.some((event) => event.type === "content_block_stop"),
      true,
      "content block is still closed at finish_reason"
    );
    assert.equal(
      finish.some((event) => event.type === "message_delta" || event.type === "message_stop"),
      false,
      "terminal events must wait for the trailing usage chunk"
    );

    // Trailing usage-only chunk (`choices: []`) completes the terminal events.
    const trailing = flatten(openaiToClaudeResponse(trailingUsageChunk(), state) as unknown[]);
    assert.equal(trailing.length, 2, "exactly message_delta + message_stop");
    assert.equal(trailing[0]?.type, "message_delta");
    assert.equal(trailing[0]?.delta?.stop_reason, "end_turn");
    assert.equal(trailing[1]?.type, "message_stop");

    const usage = trailing[0]?.usage as Record<string, unknown>;
    // OpenAI prompt_tokens includes the cached portion; Claude input_tokens must be the
    // non-cached remainder, with the cached portion exposed as cache_read_input_tokens.
    assert.equal(usage.input_tokens, 10000);
    assert.equal(usage.output_tokens, 500);
    assert.equal(usage.cache_read_input_tokens, 110000);
    // OpenAI implicit caching has no cache-write counter — never fabricate one.
    assert.equal("cache_creation_input_tokens" in usage, false);
    // No OpenAI-shape leakage into an Anthropic usage payload.
    assert.equal("prompt_tokens" in usage, false);
    assert.equal("cached_tokens" in usage, false);
    assert.equal("completion_tokens" in usage, false);
  });

  test("emits message_delta/message_stop exactly once across trailing usage duplicates", () => {
    const state = createState();
    openaiToClaudeResponse(contentChunk(), state);
    openaiToClaudeResponse(finishChunk(), state);
    const first = flatten(openaiToClaudeResponse(trailingUsageChunk(), state) as unknown[]);
    const second = openaiToClaudeResponse(trailingUsageChunk(), state);
    assert.equal(first.filter((event) => event.type === "message_stop").length, 1);
    assert.equal(second, null, "a duplicate usage-only chunk must not re-emit terminators");
  });

  test("flush (null chunk) completes a deferred finish when no trailing usage ever arrives", () => {
    const state = createState();
    openaiToClaudeResponse(contentChunk(), state);
    openaiToClaudeResponse(finishChunk(), state);

    // stream.ts flush path: translateResponse(target, source, null, state).
    const flushed = flatten(openaiToClaudeResponse(null, state) as unknown[]);
    assert.equal(flushed.length, 2);
    assert.equal(flushed[0]?.type, "message_delta");
    assert.equal(flushed[0]?.delta?.stop_reason, "end_turn");
    assert.equal(flushed[1]?.type, "message_stop");

    // Idempotent: a second flush must not duplicate the terminator.
    assert.equal(openaiToClaudeResponse(null, state), null);
  });

  test("inline usage on the finish chunk keeps emitting terminators immediately", () => {
    const state = createState();
    openaiToClaudeResponse(contentChunk(), state);
    const finish = flatten(
      openaiToClaudeResponse(
        finishChunk("chatcmpl-1", {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900 },
        }),
        state
      ) as unknown[]
    );

    const delta = finish.find((event) => event.type === "message_delta");
    assert.ok(delta, "terminal event is emitted on the finish chunk");
    assert.equal(finish.at(-1)?.type, "message_stop");
    assert.equal((delta?.usage as Record<string, unknown>).input_tokens, 100);
    assert.equal((delta?.usage as Record<string, unknown>).cache_read_input_tokens, 900);
  });

  test("a usage-only chunk that precedes finish_reason still normalizes to Claude usage", () => {
    // Some gateways attach usage to an early `choices: []` chunk (or a proxy reorders
    // events). The terminal payload must always be Anthropic-shaped, never the raw
    // OpenAI `{prompt_tokens, cached_tokens}` object.
    const state = createState();
    const usageChunk = {
      id: "chatcmpl-early",
      model: "zunef/claude-sonnet-4-5",
      choices: [],
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 4800 },
      },
    };

    assert.equal(
      openaiToClaudeResponse(usageChunk, state),
      null,
      "no terminal event before finish"
    );
    // Mirror stream.ts: it merges the extracted OpenAI usage into the shared state.
    state.usage = { prompt_tokens: 5000, completion_tokens: 40, cached_tokens: 4800 };

    const finish = flatten(
      openaiToClaudeResponse(finishChunk("chatcmpl-early"), state) as unknown[]
    );
    const delta = finish.find((event) => event.type === "message_delta");
    assert.ok(delta, "expected terminal message_delta");
    const usage = delta?.usage as Record<string, unknown>;
    assert.equal(usage.input_tokens, 200);
    assert.equal(usage.output_tokens, 40);
    assert.equal(usage.cache_read_input_tokens, 4800);
    assert.equal("prompt_tokens" in usage, false);
    assert.equal("cached_tokens" in usage, false);
  });

  test("reported cache_creation_tokens is mapped only when positive; zero is omitted", () => {
    const state = createState();
    openaiToClaudeResponse(contentChunk(), state);
    const finish = flatten(
      openaiToClaudeResponse(
        finishChunk("chatcmpl-1", {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900, cache_creation_tokens: 50 },
        }),
        state
      ) as unknown[]
    );
    const delta = finish.find((event) => event.type === "message_delta");
    const usage = delta?.usage as Record<string, unknown>;
    assert.equal(usage.cache_read_input_tokens, 900);
    assert.equal(usage.cache_creation_input_tokens, 50);
    // input = prompt - cache_read - cache_creation
    assert.equal(usage.input_tokens, 50);

    // An explicit cache_creation_tokens: 0 is not a fabricated write; omit the field.
    const state2 = createState();
    openaiToClaudeResponse(contentChunk("chatcmpl-2"), state2);
    const finish2 = flatten(
      openaiToClaudeResponse(
        finishChunk("chatcmpl-2", {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900, cache_creation_tokens: 0 },
        }),
        state2
      ) as unknown[]
    );
    const delta2 = finish2.find((event) => event.type === "message_delta");
    assert.equal((delta2?.usage as Record<string, unknown>).cache_creation_input_tokens, undefined);
  });

  test("input_tokens is clamped to zero when reported cached tokens exceed prompt_tokens", () => {
    const state = createState();
    openaiToClaudeResponse(contentChunk(), state);
    const finish = flatten(
      openaiToClaudeResponse(
        finishChunk("chatcmpl-1", {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 140 },
        }),
        state
      ) as unknown[]
    );
    const delta = finish.find((event) => event.type === "message_delta");
    assert.equal((delta?.usage as Record<string, unknown>).input_tokens, 0);
    assert.equal((delta?.usage as Record<string, unknown>).cache_read_input_tokens, 140);
  });
});
