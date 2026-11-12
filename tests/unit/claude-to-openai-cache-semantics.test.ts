/**
 * Prompt-cache semantics for the Claude → OpenAI path (zunef / freemodel-style
 * OpenAI-compatible upstreams).
 *
 * FINDING (documented here as regressions):
 *
 * 1. `cache_control` breakpoints ARE dropped when translating Claude → OpenAI for a
 *    generic OpenAI-compatible provider. That is intentional and correct: explicit
 *    `cache_control` is not part of the OpenAI Chat Completions schema, and the
 *    upstreams observed in the audit (zunef, freemodel-dev, and custom
 *    `openai-compatible-*` connections) use AUTOMATIC prefix caching, which needs no
 *    markers. Forwarding them to an upstream that does not accept them is meaningless
 *    at best and a 400 at worst. Upstreams that DO honor explicit OpenAI-format markers
 *    (alibaba/alibaba-cn/qwen-cloud/xiaomi-mimo) are allowlisted in
 *    open-sse/utils/cacheControlPolicy.ts, and a custom connection can opt in per
 *    connection with `providerSpecificData.cache.cacheControlPassthrough:
 *    "openai-format"` (#6880).
 *
 * 2. Usage accounting is truthful: OpenAI implicit caching reports only a cache-READ
 *    counter (`prompt_tokens_details.cached_tokens`, or DeepSeek's
 *    `prompt_cache_hit_tokens`). It has no cache-WRITE counter, so
 *    `cache_creation_input_tokens` / `tokens_cache_creation` stay absent (NULL) — the
 *    ~786 audit requests showing `tokens_cache_creation = 0` are the correct
 *    representation of an implicit cache, NOT a mis-mapping and NOT silently dropped
 *    writes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { claudeToOpenAIRequest } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");
const { providerHonorsOpenAIFormatCacheControl, providerSupportsCaching } =
  await import("../../open-sse/utils/cacheControlPolicy.ts");
const {
  getPromptCacheReadTokens,
  getPromptCacheCreationTokens,
  getPromptCacheReadTokensOrNull,
  getPromptCacheCreationTokensOrNull,
} = await import("../../src/lib/usage/tokenAccounting.ts");
const { extractUsage } = await import("../../open-sse/utils/usageTracking.ts");

function buildClaudeCodeBody() {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 32000,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI." },
      {
        type: "text",
        text: "Environment: darwin, /Users/operator/project",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Older turn context" },
          { type: "text", text: "Current instruction", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ],
  };
}

function hasCacheControl(node: unknown): boolean {
  return JSON.stringify(node).includes("cache_control");
}

describe("Claude → OpenAI cache_control: documented drop for implicit-cache providers", () => {
  test("zunef / freemodel-dev are NOT explicit-marker providers and not caching-allowlisted", () => {
    // Implicit-cache upstreams: no marker support is claimed, so OmniRoute must not
    // invent it. cache_read still happens upstream via automatic prefix caching.
    assert.equal(providerHonorsOpenAIFormatCacheControl("zunef"), false);
    assert.equal(providerHonorsOpenAIFormatCacheControl("freemodel-dev"), false);
    assert.equal(providerHonorsOpenAIFormatCacheControl("openai-compatible-chat-abc"), false);
    assert.equal(providerSupportsCaching("zunef"), false);
    assert.equal(providerSupportsCaching("freemodel-dev"), false);

    // Providers documented to honor OpenAI-format markers keep the passthrough.
    assert.equal(providerHonorsOpenAIFormatCacheControl("alibaba"), true);
    assert.equal(providerHonorsOpenAIFormatCacheControl("xiaomi-mimo"), true);

    // #6880 opt-in for a custom connection that genuinely accepts the markers.
    assert.equal(
      providerHonorsOpenAIFormatCacheControl("zunef", {
        cacheControlPassthrough: "openai-format",
      }),
      true
    );
  });

  test("default translation strips every cache_control breakpoint, text is preserved", () => {
    const out = claudeToOpenAIRequest(
      "zunef/claude-sonnet-4-5",
      buildClaudeCodeBody(),
      true,
      null
    ) as {
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };

    assert.equal(
      hasCacheControl(out),
      false,
      "no cache_control may reach an implicit-cache upstream"
    );
    const system = out.messages.find((m) => m.role === "system");
    assert.equal(typeof system?.content, "string", "system blocks are joined for OpenAI");
    assert.match(String(system?.content), /Claude Code/);
    assert.match(String(system?.content), /Environment: darwin/);

    const user = out.messages.find((m) => m.role === "user");
    assert.equal(Array.isArray(user?.content), true);
    const blocks = user?.content as Array<Record<string, unknown>>;
    assert.equal(
      blocks.some((b) => b.text === "Current instruction"),
      true
    );
    assert.equal(
      blocks.some((b) => b.text === "Older turn context"),
      true
    );

    const tool = out.tools[0] as { function?: { name?: string } };
    assert.equal(tool?.function?.name, "Read");
  });

  test("opt-in passthrough keeps breakpoints on the exact tagged blocks only", () => {
    // This is the contract the provider gate in translateRequest() relies on: the
    // translator only preserves markers when the credential flag is set, and the gate
    // sets it only for providers that honor OpenAI-format markers.
    const out = claudeToOpenAIRequest("zunef/claude-sonnet-4-5", buildClaudeCodeBody(), true, {
      _preserveCacheControl: true,
    }) as { messages: Array<Record<string, unknown>> };

    const system = out.messages.find((m) => m.role === "system");
    const systemBlocks = system?.content as Array<Record<string, unknown>>;
    assert.deepEqual(
      systemBlocks.find((b) => b.text === "Environment: darwin, /Users/operator/project")
        ?.cache_control,
      { type: "ephemeral" }
    );
    assert.equal(
      systemBlocks.find((b) => String(b.text).startsWith("You are Claude Code"))?.cache_control,
      undefined,
      "untagged system block must stay untagged"
    );

    const user = out.messages.find((m) => m.role === "user");
    const userBlocks = user?.content as Array<Record<string, unknown>>;
    assert.deepEqual(userBlocks.find((b) => b.text === "Current instruction")?.cache_control, {
      type: "ephemeral",
    });
    assert.equal(userBlocks.find((b) => b.text === "Older turn context")?.cache_control, undefined);
  });
});

describe("Implicit-cache usage accounting: cache_read mapped, cache_creation never invented", () => {
  const OPENAI_IMPLICIT_CACHE_USAGE = {
    prompt_tokens: 109691,
    completion_tokens: 1200,
    total_tokens: 110891,
    prompt_tokens_details: { cached_tokens: 52550 },
  };

  test("tokens_cache_read is derived from cached_tokens", () => {
    assert.equal(getPromptCacheReadTokens(OPENAI_IMPLICIT_CACHE_USAGE), 52550);
    assert.equal(getPromptCacheReadTokensOrNull(OPENAI_IMPLICIT_CACHE_USAGE), 52550);
  });

  test("tokens_cache_creation is NULL (not 0) when the upstream has no write counter", () => {
    // call_logs/usage_history writers use the *OrNull variants so an implicit-cache
    // provider records "not reported" instead of a fake explicit zero/write.
    assert.equal(getPromptCacheCreationTokensOrNull(OPENAI_IMPLICIT_CACHE_USAGE), null);
    assert.equal(getPromptCacheCreationTokens(OPENAI_IMPLICIT_CACHE_USAGE), 0);
  });

  test("DeepSeek-style prompt_cache_hit_tokens still maps to cache_read downstream", () => {
    // extractUsage normalizes the native DeepSeek field into cached_tokens, which is
    // what the call-log/usage_history writers read.
    const extracted = extractUsage({
      id: "chatcmpl-deepseek",
      choices: [],
      usage: {
        prompt_tokens: 4364,
        completion_tokens: 27,
        prompt_cache_hit_tokens: 4352,
        prompt_cache_miss_tokens: 12,
      },
    }) as Record<string, unknown>;
    assert.equal(extracted.cached_tokens, 4352);
    assert.equal(getPromptCacheReadTokens(extracted), 4352);
    assert.equal(getPromptCacheCreationTokensOrNull(extracted), null);
  });

  test("an explicit upstream cache_creation_tokens is preserved (and 0 is a reported zero)", () => {
    const explicitWrite = {
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 900, cache_creation_tokens: 100 },
    };
    assert.equal(getPromptCacheCreationTokensOrNull(explicitWrite), 100);

    const reportedZero = {
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 900, cache_creation_tokens: 0 },
    };
    assert.equal(getPromptCacheCreationTokensOrNull(reportedZero), 0);
  });

  test("a usage-only trailing chunk still counts in call_logs (why logs looked healthy)", () => {
    // stream.ts extracts usage from EVERY upstream chunk before translation, including
    // the `choices: []` trailer. That is why call_logs showed high cache_read even when
    // the client-facing Claude usage dropped it (fixed in
    // openai-to-claude-trailing-usage.test.ts).
    const extracted = extractUsage({
      id: "chatcmpl-trailer",
      choices: [],
      usage: OPENAI_IMPLICIT_CACHE_USAGE,
    }) as Record<string, unknown>;
    assert.equal(extracted.prompt_tokens, 109691);
    assert.equal(getPromptCacheReadTokens(extracted), 52550);
    assert.equal(getPromptCacheCreationTokensOrNull(extracted), null);
  });
});
