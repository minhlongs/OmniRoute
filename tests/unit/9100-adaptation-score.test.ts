// Unit tests for the Auto-Combo Adaptation scoring engine (score.ts).
//
// Coverage:
//  - EMA success/failure drift (alpha 0.1, default 0.5)
//  - Latency penalty relative to self-baseline (ratio > 2 → penalty, cap 0.3)
//  - Baseline updates only on success (never poisoned by failure latency)
//  - Quarantine conjunction: score < 0.2 AND consecutiveFailures >= 3
//  - Weight scaling via applyScoreToWeight
//  - Clamps: score floor 0.05, ceiling 1.0
import test from "node:test";
import assert from "node:assert/strict";

const {
  SCORE_ALPHA,
  MIN_SCORE,
  QUARANTINE_SCORE_THRESHOLD,
  QUARANTINE_MIN_FAILURES,
  LATENCY_PENALTY_RATIO,
  LATENCY_PENALTY_MAX,
  computeScore,
  computeBaseline,
  shouldQuarantine,
  applyScoreToWeight,
} = await import("../../open-sse/services/combo/adaptation/score.ts");

test("constants match the plan (v1 decisions)", () => {
  assert.equal(SCORE_ALPHA, 0.1);
  assert.equal(MIN_SCORE, 0.05);
  assert.equal(QUARANTINE_SCORE_THRESHOLD, 0.2);
  assert.equal(QUARANTINE_MIN_FAILURES, 3);
  assert.equal(LATENCY_PENALTY_RATIO, 2);
  assert.equal(LATENCY_PENALTY_MAX, 0.3);
});

test("success drifts score up with EMA 0.1", () => {
  const s = computeScore(0.5, "success", 1000, 1000);
  assert.ok(Math.abs(s - 0.55) < 1e-9, `expected 0.55, got ${s}`);
});

test("failure drifts score down with EMA 0.1", () => {
  const s = computeScore(0.5, "failure", 1000, 1000);
  assert.ok(Math.abs(s - 0.45) < 1e-9, `expected 0.45, got ${s}`);
});

test("slow success gets latency penalty (ratio 4 → −0.2)", () => {
  const s = computeScore(0.5, "success", 4000, 1000);
  const expected = 0.55 - ((4 - 2) / 3) * 0.3;
  assert.ok(Math.abs(s - expected) < 1e-9, `expected ${expected}, got ${s}`);
});

test("latency penalty capped at 0.3 (ratio >= 5)", () => {
  const s = computeScore(0.5, "success", 10_000, 1000);
  const expected = 0.55 - 0.3;
  assert.ok(Math.abs(s - expected) < 1e-9, `got ${s}`);
});

test("no latency penalty when ratio <= 2", () => {
  const s = computeScore(0.5, "success", 2000, 1000);
  assert.ok(Math.abs(s - 0.55) < 1e-9, `got ${s}`);
});

test("no latency penalty when no baseline known (baselineMs <= 0)", () => {
  const s = computeScore(0.5, "success", 50_000, 0);
  assert.ok(Math.abs(s - 0.55) < 1e-9, `got ${s}`);
});

test("score clamped to floor 0.05", () => {
  let s = 0.5;
  for (let i = 0; i < 40; i++) s = computeScore(s, "failure", 1000, 1000);
  assert.ok(s >= MIN_SCORE - 1e-12, `floor violated: ${s}`);
});

test("score clamped to ceiling 1.0", () => {
  let s = 0.5;
  for (let i = 0; i < 40; i++) s = computeScore(s, "success", 1000, 1000);
  assert.ok(s <= 1.0 + 1e-12, `ceiling violated: ${s}`);
});

test("baseline updates on success only", () => {
  assert.equal(computeBaseline(0, 2000, "success"), 2000, "seed on first success");
  const next = computeBaseline(2000, 3000, "success");
  assert.ok(Math.abs(next - (2000 * 0.9 + 3000 * 0.1)) < 1e-9, `got ${next}`);
  const same = computeBaseline(2000, 100, "failure");
  assert.equal(same, 2000, "failure must not poison baseline");
});

test("quarantine requires BOTH low score AND enough consecutive failures", () => {
  assert.equal(shouldQuarantine(0.1, 3), true, "low + enough → quarantine");
  assert.equal(shouldQuarantine(0.19, 3), true);
  assert.equal(shouldQuarantine(0.2, 3), false, "boundary 0.2 not quarantined");
  assert.equal(shouldQuarantine(0.1, 2), false, "not enough failures");
  assert.equal(shouldQuarantine(0.1, 0), false);
  assert.equal(shouldQuarantine(0.9, 10), false, "healthy score never quarantined");
});

test("weight scales by learned score", () => {
  assert.ok(Math.abs(applyScoreToWeight(3, 0.5) - 1.5) < 1e-9);
  assert.equal(applyScoreToWeight(3, 1), 3);
  assert.ok(Math.abs(applyScoreToWeight(3, 0.05) - 0.15) < 1e-9);
  assert.ok(applyScoreToWeight(3, 0) >= 0);
});

test("repeated failures collapse score toward floor", () => {
  let s = 0.5;
  for (let i = 0; i < 30; i++) s = computeScore(s, "failure", 1000, 1000);
  assert.ok(s < QUARANTINE_SCORE_THRESHOLD, `score should be < 0.2 after 30 failures, got ${s}`);
  assert.ok(s >= MIN_SCORE - 1e-12);
});

test("repeated successes recover score above quarantine threshold", () => {
  let s = 0.05;
  for (let i = 0; i < 30; i++) s = computeScore(s, "success", 1000, 1000);
  assert.ok(s > QUARANTINE_SCORE_THRESHOLD, `score should recover, got ${s}`);
});
