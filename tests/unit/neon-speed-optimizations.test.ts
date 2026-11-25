import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-neon-speed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { _clearInflightForTest } = await import(
  "../../open-sse/services/combo/quotaShareInflight.ts"
);
const {
  clearGeminiThoughtSignatures,
  clearGeminiThoughtSignatureMemoryForTests,
  getGeminiThoughtSignature,
  getGeminiThoughtSignatureMemorySizeForTests,
  storeGeminiThoughtSignature,
  __getThoughtSignatureStoreLimitsForTest,
} = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const {
  getDefaultDispatcherConnectionLimit,
  getDirectH2PoolSize,
  __getDirectDispatcherPoolMetaForTest,
} = await import("../../open-sse/utils/proxyDispatcher.ts");
const { selectAntigravityPoolConnection } = await import(
  "../../src/sse/services/antigravityPoolSelector.ts"
);

function resetState() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  _clearInflightForTest();
  clearGeminiThoughtSignatures();
}

test("geminiThoughtSignatureStore increases capacity, 24h TTL, promotes MRU hits, and never exceeds maxMemory on DB hit", () => {
  resetState();
  const limits = __getThoughtSignatureStoreLimitsForTest();
  assert.equal(limits.maxMemory, 10_000);
  assert.equal(limits.maxPersisted, 20_000);
  assert.equal(limits.memoryTtlMs, 86_400_000);
  assert.equal(limits.pruneIntervalMs, 60_000);

  // Store hot entry first, then fill to exact cap
  storeGeminiThoughtSignature("hot-oldest", "sig-hot");
  for (let i = 0; i < limits.maxMemory - 1; i++) {
    storeGeminiThoughtSignature(`filler-${i}`, `sig-${i}`);
  }
  assert.equal(getGeminiThoughtSignatureMemorySizeForTests(), limits.maxMemory);

  // Touching hot-oldest promotes it to MRU so overflow evicts filler-0 instead of hot-oldest
  assert.equal(getGeminiThoughtSignature("hot-oldest"), "sig-hot");
  storeGeminiThoughtSignature("overflow-new", "sig-new");
  assert.equal(getGeminiThoughtSignatureMemorySizeForTests(), limits.maxMemory);

  // Persist a DB-only signature, refill memory to cap, read DB entry and verify memory remains <= maxMemory
  storeGeminiThoughtSignature("db-only-key", "sig-db-only");
  clearGeminiThoughtSignatureMemoryForTests();
  for (let i = 0; i < limits.maxMemory; i++) {
    storeGeminiThoughtSignature(`cap-fill-${i}`, `sig-cap-${i}`);
  }
  assert.equal(getGeminiThoughtSignature("db-only-key"), "sig-db-only");
  assert.ok(getGeminiThoughtSignatureMemorySizeForTests() <= limits.maxMemory);

  clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(getGeminiThoughtSignature("hot-oldest"), "sig-hot");
});

test("proxyDispatcher consolidates direct H2 pool cleanly, never exceeds connectionLimit, and honors OMNIROUTE_DIRECT_H2 toggle", () => {
  assert.equal(getDefaultDispatcherConnectionLimit({}), 32);
  assert.equal(getDirectH2PoolSize({}), 4);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "" }), 4);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "0" }), 4);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "-5" }), 4);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "abc" }), 4);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "999" }), 256);
  assert.equal(getDirectH2PoolSize({ OMNIROUTE_DIRECT_H2_POOL_SIZE: "8" }), 8);

  const meta = __getDirectDispatcherPoolMetaForTest({});
  assert.deepEqual(meta, {
    poolSize: 4,
    connectionsPerAgent: 8,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
    keepAliveTimeoutThreshold: 1000,
    allowH2: true,
    pipelining: 1,
  });

  // Never exceeds connectionLimit across small or NaN limits
  for (const limit of [1, 3, 4, 8, 32, Number.NaN]) {
    const m = __getDirectDispatcherPoolMetaForTest({}, limit);
    const effective = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 32;
    assert.ok(m.poolSize >= 1 && m.connectionsPerAgent >= 1);
    assert.ok(m.poolSize * m.connectionsPerAgent <= effective, `Exceeded ${effective} for limit=${limit}`);
  }

  // OMNIROUTE_DIRECT_H2 kill-switch
  assert.equal(__getDirectDispatcherPoolMetaForTest({ OMNIROUTE_DIRECT_H2: "0" }).allowH2, false);
  assert.equal(__getDirectDispatcherPoolMetaForTest({ OMNIROUTE_DIRECT_H2: "false" }).allowH2, false);
  assert.equal(__getDirectDispatcherPoolMetaForTest({ OMNIROUTE_DIRECT_H2: "true" }).allowH2, true);
});

test("antigravityPoolSelector distributes concurrent bursts and idle waves evenly across 4 equal-P1 accounts without lastUsedAt starvation", async () => {
  resetState();
  const cursor = new Map<string, number>();

  // Mixed/null lastUsedAt MUST NOT collapse round-robin or cause thundering herd onto 1 idle/null account
  const poolWithMixedTimestamps = [
    { id: "0085d792-longtho", provider: "agy", priority: 1, name: "longtho", lastUsedAt: "2026-11-25T13:30:00.000Z" },
    { id: "ac0b226d-billwill", provider: "agy", priority: 1, name: "billwill", lastUsedAt: "2026-11-25T13:29:00.000Z" },
    { id: "a5df266a-huuthong", provider: "agy", priority: 1, name: "huuthong", lastUsedAt: "2026-11-25T13:20:00.000Z" },
    { id: "eefd43a7-txsd", provider: "agy", priority: 1, name: "txsd", lastUsedAt: null },
  ];

  // Concurrent 4-session burst (none released yet -> 1 inflight per account, no thundering herd!)
  const concurrentReleases: Array<() => void> = [];
  const concurrentPicked: string[] = [];
  for (let i = 0; i < 4; i++) {
    const pick = selectAntigravityPoolConnection({
      provider: "agy",
      requestedModel: "gemini-pro-orchestrator-neon",
      orderedConnections: poolWithMixedTimestamps,
      isClaudeModel: false,
      sessionKey: `sess-burst-${i}`,
      sessionAffinityTtlMs: 1_800_000,
      skipSideEffects: false,
      providerRoundRobinCursor: cursor,
      planLastUsedCommit: () => async () => {},
    });
    await pick.commitSideEffects();
    concurrentPicked.push(pick.connection.id);
    if (pick.releaseInflight) concurrentReleases.push(pick.releaseInflight);
  }
  assert.equal(new Set(concurrentPicked).size, 4, `Expected concurrent burst spread across all 4 P1 accounts, got ${concurrentPicked}`);
  for (const rel of concurrentReleases) rel();

  // Sequential 4 idle new sessions (all at inflight=0) also spread evenly 25/25/25/25
  const seqPicked: string[] = [];
  for (let i = 0; i < 4; i++) {
    const pick = selectAntigravityPoolConnection({
      provider: "agy",
      requestedModel: "gemini-pro-orchestrator-neon",
      orderedConnections: poolWithMixedTimestamps,
      isClaudeModel: false,
      sessionKey: `sess-seq-${i}`,
      sessionAffinityTtlMs: 1_800_000,
      skipSideEffects: false,
      providerRoundRobinCursor: cursor,
      planLastUsedCommit: () => async () => {},
    });
    await pick.commitSideEffects();
    seqPicked.push(pick.connection.id);
    pick.releaseInflight?.();
  }
  assert.equal(new Set(seqPicked).size, 4, `Expected sequential spread across all 4 P1 accounts, got ${seqPicked}`);

  // Session affinity pin stays sticky across turns
  const pinnedFollowUp = selectAntigravityPoolConnection({
    provider: "agy",
    requestedModel: "gemini-pro-orchestrator-neon",
    orderedConnections: poolWithMixedTimestamps,
    isClaudeModel: false,
    sessionKey: "sess-seq-2",
    sessionAffinityTtlMs: 1_800_000,
    skipSideEffects: false,
    providerRoundRobinCursor: cursor,
    planLastUsedCommit: () => async () => {},
  });
  await pinnedFollowUp.commitSideEffects();
  assert.equal(pinnedFollowUp.connection.id, seqPicked[2]);
  pinnedFollowUp.releaseInflight?.();
});
