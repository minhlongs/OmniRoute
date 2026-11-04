/**
 * TPM gate wiring — `withRateLimit` must pace on TOKENS, not just requests.
 *
 * Regression guard for the gap that let zunef burn its rolling-minute token
 * budget with a handful of 100k-token prompts: the limiter only ever looked at
 * request count. With a `tpm` override the gate must delay (and eventually
 * reject with a 429-class error) a dispatch whose token cost no longer fits.
 */
import test from "node:test";
import assert from "node:assert/strict";

const rlm = await import("../../open-sse/services/rateLimitManager.ts");
const budget = await import("../../open-sse/services/rateLimitManager/tokenBudget.ts");

test.beforeEach(async () => {
  await rlm.__resetRateLimitManagerForTests();
  budget.__resetTokenBudgetsForTests();
});

test("no tpm override keeps the old behaviour (no token pacing)", async () => {
  rlm.enableRateLimitProtection("conn-plain");
  const started = Date.now();
  const result = await rlm.withRateLimit(
    "test-provider",
    "conn-plain",
    null,
    async () => "ok",
    null,
    1_000,
    null,
    { tokenCost: 5_000_000 }
  );
  assert.equal(result, "ok");
  assert.ok(Date.now() - started < 500, "an unconfigured connection must not be paced");
});

test("a dispatch that no longer fits the tpm budget waits, then fails with 429-class error", async () => {
  rlm.enableRateLimitProtection("conn-tpm");
  rlm.refreshConnectionRateLimits("conn-tpm", { tpm: 1_000 });

  await rlm.withRateLimit("test-provider", "conn-tpm", null, async () => "a", null, 500, null, {
    tokenCost: 800,
  });

  const started = Date.now();
  await assert.rejects(
    rlm.withRateLimit("test-provider", "conn-tpm", null, async () => "b", null, 80, null, {
      tokenCost: 800,
    }),
    (err: Error & { status?: number; code?: string }) =>
      err.code === "RATE_LIMIT_TPM_BUDGET" || err.status === 429
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40, `expected the gate to wait before rejecting, waited ${elapsed}ms`);
});

test("a dispatch that fits the budget is not delayed", async () => {
  rlm.enableRateLimitProtection("conn-fit");
  rlm.refreshConnectionRateLimits("conn-fit", { tpm: 10_000 });

  const started = Date.now();
  const result = await rlm.withRateLimit(
    "test-provider",
    "conn-fit",
    null,
    async () => "ok",
    null,
    1_000,
    null,
    { tokenCost: 500 }
  );
  assert.equal(result, "ok");
  assert.ok(Date.now() - started < 500);
});
