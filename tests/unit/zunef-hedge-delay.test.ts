/**
 * Zunef legs used to wait a hardcoded 60s before hedging, silently ignoring the
 * combo's configured `hedgeDelayMs` — so `hedging: true` was a no-op on every
 * Zunef-first combo (the operator sets 1s, production waits 60s).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveZunefHedgeDelayMs } =
  await import("../../open-sse/services/combo/comboAttemptLoop.ts");

test("hedging disabled keeps the 60s Zunef default", () => {
  assert.equal(resolveZunefHedgeDelayMs(false, 1_000), 60_000);
  assert.equal(resolveZunefHedgeDelayMs(false, undefined), 60_000);
});

test("hedging enabled honours the configured delay", () => {
  assert.equal(resolveZunefHedgeDelayMs(true, 1_000), 1_000);
  assert.equal(resolveZunefHedgeDelayMs(true, 2_500), 2_500);
  assert.equal(resolveZunefHedgeDelayMs(true, "3000"), 3_000);
});

test("a configured delay longer than the default is clamped", () => {
  assert.equal(resolveZunefHedgeDelayMs(true, 90_000), 60_000);
});

test("missing or invalid delays fall back to the default", () => {
  assert.equal(resolveZunefHedgeDelayMs(true, undefined), 60_000);
  assert.equal(resolveZunefHedgeDelayMs(true, 0), 60_000);
  assert.equal(resolveZunefHedgeDelayMs(true, -5), 60_000);
  assert.equal(resolveZunefHedgeDelayMs(true, "nope"), 60_000);
});
