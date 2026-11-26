import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-neon-floor-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const tokenRefresh = await import("../../src/sse/services/tokenRefresh.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { openaiToGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { markComboStepEffort } = await import("../../open-sse/services/combo/comboStepEffort.ts");
const { __test_applyAntigravityGenerationDefaults: applyAntigravityGenerationDefaults } =
  await import("../../open-sse/executors/antigravity.ts");

function baseClaudeBody(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK" }] }],
    max_tokens: 512,
    ...extra,
  };
}

function baseOpenAiBody(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: "Reply with OK" }],
    max_tokens: 512,
    ...extra,
  };
}

async function withMockedFetch(fetchImpl: typeof globalThis.fetch, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ── Fix #1a: claudeToGeminiRequest minThinkingBudget floor ──────────────────────

test("claudeToGeminiRequest: neon thinking=disabled clamps to minThinkingBudget 1024 with includeThoughts=false", () => {
  const out = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ thinking: { type: "disabled" } }),
    true
  );
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("claudeToGeminiRequest: neon combo reasoningEffort='none' clamps to 1024 with includeThoughts=false", () => {
  const outputConfig = { effort: "none" };
  const body = baseClaudeBody({ output_config: outputConfig });
  markComboStepEffort(body, outputConfig);
  const out = claudeToGeminiRequest("agy/gemini-pro-orchestrator-neon", body, true);
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("claudeToGeminiRequest: neon output_config.effort='none' clamps to 1024 with includeThoughts=false", () => {
  const out = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ output_config: { effort: "none" } }),
    true
  );
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("claudeToGeminiRequest: neon omitted thinking/effort gets 1024 floor with includeThoughts=false", () => {
  const out = claudeToGeminiRequest("gemini-pro-orchestrator-neon", baseClaudeBody(), true);
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("claudeToGeminiRequest: neon output_config.effort='low' and 'high' remain unchanged", () => {
  const lowOut = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ output_config: { effort: "low" } }),
    true
  );
  assert.deepEqual(lowOut.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: true,
  });

  const highOut = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ output_config: { effort: "high" } }),
    true
  );
  assert.deepEqual(highOut.generationConfig.thinkingConfig, {
    thinkingBudget: 8192,
    includeThoughts: true,
  });
});

test("claudeToGeminiRequest: gemini-2.5-pro thinking=disabled still omits thinkingConfig (no regression)", () => {
  const out = claudeToGeminiRequest(
    "gemini-2.5-pro",
    baseClaudeBody({ thinking: { type: "disabled" } }),
    true
  );
  assert.equal(out.generationConfig.thinkingConfig, undefined);
});

// ── Fix #1b: openaiToGeminiRequest minThinkingBudget floor ──────────────────────

test("openaiToGeminiRequest: neon reasoning_effort='none' clamps to 1024 with includeThoughts=false", () => {
  const out = openaiToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseOpenAiBody({ reasoning_effort: "none" }),
    true
  ) as { generationConfig: { thinkingConfig?: unknown } };
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("openaiToGeminiRequest: neon thinking=disabled clamps to 1024 with includeThoughts=false", () => {
  const out = openaiToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseOpenAiBody({ thinking: { type: "disabled" } }),
    true
  ) as { generationConfig: { thinkingConfig?: unknown } };
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });
});

test("openaiToGeminiRequest: gemini-2.5-pro reasoning_effort='none' still emits thinkingBudget=0", () => {
  const out = openaiToGeminiRequest(
    "gemini-2.5-pro",
    baseOpenAiBody({ reasoning_effort: "none" }),
    true
  ) as { generationConfig: { thinkingConfig?: unknown } };
  assert.deepEqual(out.generationConfig.thinkingConfig, {
    thinkingBudget: 0,
    includeThoughts: false,
  });
});

// ── Fix #1c: applyAntigravityGenerationDefaults visible headroom ────────────────

test("applyAntigravityGenerationDefaults gives visible output headroom for neon short maxOutputTokens", () => {
  const req: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: false },
    },
  };
  applyAntigravityGenerationDefaults(req, "gemini-pro-orchestrator-neon");
  const gc = req.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, 1280);
});

test("applyAntigravityGenerationDefaults: neon preserves >=256 visible headroom for 1025, adaptive omitted budget, and 2048", () => {
  const req1025: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 1025,
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: false },
    },
  };
  applyAntigravityGenerationDefaults(req1025, "gemini-pro-orchestrator-neon");
  assert.equal((req1025.generationConfig as Record<string, unknown>).maxOutputTokens, 1280);

  const reqAdaptive: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 512,
      thinkingConfig: { includeThoughts: true },
    },
  };
  applyAntigravityGenerationDefaults(reqAdaptive, "gemini-pro-orchestrator-neon");
  assert.equal((reqAdaptive.generationConfig as Record<string, unknown>).maxOutputTokens, 1536);

  const req2048: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: false },
    },
  };
  applyAntigravityGenerationDefaults(req2048, "gemini-pro-orchestrator-neon");
  assert.equal((req2048.generationConfig as Record<string, unknown>).maxOutputTokens, 2048);
});

test("openaiToGeminiRequest: neon budget_tokens=0 clamps to 1024 hidden floor & omitted thinking uses 2048 default", () => {
  const outZero = openaiToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseOpenAiBody({ thinking: { type: "enabled", budget_tokens: 0 } }),
    true
  ) as { generationConfig: { thinkingConfig?: unknown } };
  assert.deepEqual(outZero.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: false,
  });

  const outOmitted = openaiToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseOpenAiBody(),
    true
  ) as { generationConfig: { thinkingConfig?: unknown } };
  assert.deepEqual(outOmitted.generationConfig.thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true,
  });
});

test("claudeToGeminiRequest: neon budget_tokens=0 clamps to 1024 (visible) & adaptive uses 2048 default", () => {
  const outZero = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ thinking: { type: "enabled", budget_tokens: 0 } }),
    true
  );
  assert.deepEqual(outZero.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: true,
  });

  const outAdaptive = claudeToGeminiRequest(
    "gemini-pro-orchestrator-neon",
    baseClaudeBody({ thinking: { type: "adaptive" } }),
    true
  );
  assert.deepEqual(outAdaptive.generationConfig.thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true,
  });
});

// ── Fix #2: checkAndRefreshToken non-blocking background refresh ────────────────

test("checkAndRefreshToken: antigravity with 600s left refreshes in background non-blocking & deduplicates", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "bg-refresh-agy-test",
    providerSpecificData: { projectId: "test-proj" },
    accessToken: "old-agy-access-token",
    refreshToken: "old-agy-refresh-token",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  let fetchCalls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  await withMockedFetch(
    (async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        fetchCalls++;
        await fetchGate;
      }
      return new Response(
        JSON.stringify({ access_token: "new-agy-access-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof globalThis.fetch,
    async () => {
      const creds = {
        connectionId: created.id,
        accessToken: "old-agy-access-token",
        refreshToken: "old-agy-refresh-token",
        providerSpecificData: { projectId: "test-proj" },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };

      const t0 = Date.now();
      const [res1, res2] = await Promise.all([
        tokenRefresh.checkAndRefreshToken("antigravity", creds),
        tokenRefresh.checkAndRefreshToken("antigravity", creds),
      ]);
      const elapsed = Date.now() - t0;

      assert.ok(elapsed < 100, `expected immediate non-blocking return, took ${elapsed}ms`);
      assert.equal(res1.accessToken, "old-agy-access-token");
      assert.equal(res2.accessToken, "old-agy-access-token");
      assert.equal(tokenRefresh.__getBackgroundRefreshInFlightCountForTest(), 1);

      releaseFetch();
      // Give background promise microtasks + DB write time to finish
      for (let i = 0; i < 40; i++) {
        if (tokenRefresh.__getBackgroundRefreshInFlightCountForTest() === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(fetchCalls, 1, "concurrent calls must coalesce into 1 background refresh");
      assert.equal(tokenRefresh.__getBackgroundRefreshInFlightCountForTest(), 0);
    }
  );
});

test("checkAndRefreshToken: background refresh failure clears in-flight guard cleanly", async () => {
  await withMockedFetch(
    (async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    async () => {
      const res = await tokenRefresh.checkAndRefreshToken("antigravity", {
        connectionId: "conn-fail-cleanup",
        accessToken: "still-valid-token",
        refreshToken: "revoked-refresh",
        expiresAt: new Date(Date.now() + 500_000).toISOString(),
      });
      assert.equal(res.accessToken, "still-valid-token");
      for (let i = 0; i < 40; i++) {
        if (tokenRefresh.__getBackgroundRefreshInFlightCountForTest() === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(tokenRefresh.__getBackgroundRefreshInFlightCountForTest(), 0);
    }
  );
});

test("checkAndRefreshToken: antigravity <=120s remaining and codex 200s remaining still refresh synchronously", async () => {
  let calls = 0;
  await withMockedFetch(
    (async (url) => {
      if (String(url).includes("/token")) {
        calls++;
      }
      return new Response(
        JSON.stringify({
          access_token: `sync-token-${calls}`,
          refresh_token: `sync-refresh-${calls}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof globalThis.fetch,
    async () => {
      const agyNearExpiry = await tokenRefresh.checkAndRefreshToken("antigravity", {
        connectionId: "conn-near-expiry",
        accessToken: "old-token",
        refreshToken: "ref-1",
        providerSpecificData: { projectId: "test-proj" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(agyNearExpiry.accessToken, "sync-token-1");

      const codexRotating = await tokenRefresh.checkAndRefreshToken("codex", {
        connectionId: "conn-codex-rotating",
        accessToken: "old-codex",
        refreshToken: "codex-ref-1",
        expiresAt: new Date(Date.now() + 200_000).toISOString(),
      });
      assert.equal(codexRotating.accessToken, "sync-token-2");
    }
  );
});
