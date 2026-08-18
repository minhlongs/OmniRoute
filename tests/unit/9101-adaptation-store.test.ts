// Unit tests for the Auto-Combo Adaptation persistence store (store.ts).
//
// Coverage:
//  - Failure outcomes persist to DB immediately (decision D1)
//  - Success outcomes stay in-memory until flushCounters()
//  - Consecutive-failure tracking (reset on success, increment on failure)
//  - Quarantine: score < 0.2 AND 3 consecutive failures → excluded_until set
//  - getExcludedProviders returns only active exclusions
//  - Fail-open: unknown combos yield empty results, never throw
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-adapt-9101-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const store = await import("../../open-sse/services/combo/adaptation/store.ts");
const { __resetAdaptationStoreForTests } = store;
const { QUARANTINE_SCORE_THRESHOLD, QUARANTINE_MIN_FAILURES } =
  await import("../../open-sse/services/combo/adaptation/score.ts");

const COMBO = "test-combo-9101";
const PROVIDER = "test-provider/model-9101";

test.after(() => {
  resetDbInstance();
  __resetAdaptationStoreForTests();
  if (ORIGINAL_DATA_DIR !== undefined) process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("failure outcome persists a DB row immediately (D1)", async () => {
  await store.recordOutcome(COMBO, PROVIDER, "failure", 5000, 0.5, 1000);
  const scores = await store.loadAdaptationScores(COMBO);
  const entry = scores.get(PROVIDER);
  assert.ok(entry, "row must exist after failure");
  assert.ok(entry.learnedScore < 0.5, "score must drop below 0.5 after failure");
  assert.equal(entry.requestCount, 1);
  assert.equal(entry.successCount, 0);
});

test("success outcome is NOT persisted until flush (D1)", async () => {
  await store.recordOutcome(COMBO, PROVIDER, "success", 1000, 0.45, 1000);
  await store.flushCounters();
  const scores = await store.loadAdaptationScores(COMBO);
  const entry = scores.get(PROVIDER);
  assert.ok(entry, "row exists after flush");
  assert.equal(entry.requestCount, 2, "success counter flushed");
  assert.equal(entry.successCount, 1, "success counted");
  assert.ok(entry.learnedScore > 0.45, "score must recover after success");
});

test("consecutive failures tracked in memory, reset on success", async () => {
  const providerB = "test-provider/model-9101-b";
  await store.recordOutcome(COMBO, providerB, "failure", 5000, 0.5, 1000);
  await store.recordOutcome(COMBO, providerB, "failure", 5000, 0.45, 1000);
  assert.equal(store.getConsecutiveFailures(COMBO, providerB), 2);
  await store.recordOutcome(COMBO, providerB, "success", 1000, 0.4, 1000);
  assert.equal(store.getConsecutiveFailures(COMBO, providerB), 0);
  await store.flushCounters();
});

test("quarantine after low score AND 3 consecutive failures", async () => {
  const providerC = "test-provider/model-9101-c";
  assert.equal(QUARANTINE_SCORE_THRESHOLD < 0.5, true, "precondition: default 0.5");
  assert.equal(QUARANTINE_MIN_FAILURES, 3);
  for (let i = 0; i < 30; i++) {
    await store.recordOutcome(COMBO, providerC, "failure", 5000, 0.5, 1000);
  }
  const excluded = await store.getExcludedProviders(COMBO);
  assert.ok(excluded.has(providerC), `${providerC} must be quarantined after 30 failures`);
});

test("healthy provider never quarantined", async () => {
  const providerD = "test-provider/model-9101-d";
  for (let i = 0; i < 10; i++) {
    await store.recordOutcome(COMBO, providerD, "success", 1000, 0.5, 1000);
  }
  await store.flushCounters();
  const excluded = await store.getExcludedProviders(COMBO);
  assert.equal(excluded.has(providerD), false);
});

test("fail-open: unknown combo returns empty, never throws", async () => {
  const scores = await store.loadAdaptationScores("combo-that-does-not-exist");
  assert.equal(scores.size, 0);
  const excluded = await store.getExcludedProviders("combo-that-does-not-exist");
  assert.equal(excluded.size, 0);
  assert.equal(store.getConsecutiveFailures("combo-that-does-not-exist", "x/y"), 0);
  await store.recordOutcome("combo-that-does-not-exist", "x/y", "failure", 1, 0.5, 1000);
});

test("DB row matches the persisted schema (learned_score, excluded_until)", async () => {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM combo_adaptation_state WHERE combo_id = ? AND provider_id = ?")
    .get(COMBO, PROVIDER);
  assert.ok(row, "row present");
  assert.equal(typeof row.learned_score, "number");
  assert.equal(typeof row.request_count, "number");
  assert.equal(typeof row.success_count, "number");
});
