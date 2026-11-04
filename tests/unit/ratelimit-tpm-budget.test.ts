/**
 * TPM (tokens-per-minute) budget — the missing half of the local rate limiter.
 *
 * `rateLimitManager` only ever bounded REQUESTS (RPM / minTime / maxConcurrent).
 * Providers that meter by TOKEN rate (zunef, Gemini free tier, most resellers)
 * return 429 "rate_limit_error" as soon as the token budget for the rolling
 * minute is gone — a 100k-token request burns that budget in one shot, no matter
 * how politely the request rate is paced. This module is the token bucket the
 * limiter was missing.
 *
 * Pure on purpose: every function takes `now` so the window behaviour is
 * testable without sleeping.
 */
import test from "node:test";
import assert from "node:assert/strict";

const budget = await import("../../open-sse/services/rateLimitManager/tokenBudget.ts");
const { tokensUsedInWindow, waitMsForTokenBudget, reserveTokens, __resetTokenBudgetsForTests } =
  budget;

test.beforeEach(() => {
  __resetTokenBudgetsForTests();
});

test("a request that fits the budget is admitted immediately", () => {
  const now = 1_000_000;
  assert.equal(waitMsForTokenBudget("conn-a", 10_000, 4_000, now), 0);
  reserveTokens("conn-a", 4_000, now);
  assert.equal(tokensUsedInWindow("conn-a", now), 4_000);
});

test("the budget reports the wait until enough of the window expires", () => {
  const t0 = 2_000_000;
  reserveTokens("conn-b", 8_000, t0);
  // 8k of a 10k budget is spent; a 5k request needs 3k to age out.
  const wait = waitMsForTokenBudget("conn-b", 10_000, 5_000, t0 + 10_000);
  assert.ok(wait > 0, "expected a positive wait");
  assert.ok(wait <= 50_000, `wait must fall inside the 60s window, got ${wait}`);
  // After the full window the budget is empty again.
  assert.equal(waitMsForTokenBudget("conn-b", 10_000, 5_000, t0 + 60_001), 0);
});

test("spend falls out of the rolling 60s window", () => {
  const t0 = 3_000_000;
  reserveTokens("conn-c", 9_000, t0);
  assert.equal(tokensUsedInWindow("conn-c", t0 + 59_000), 9_000);
  assert.equal(tokensUsedInWindow("conn-c", t0 + 60_001), 0);
});

test("a single request larger than the whole budget is admitted once", () => {
  // Splitting is impossible, and rejecting it forever would deadlock the caller.
  const now = 4_000_000;
  assert.equal(waitMsForTokenBudget("conn-d", 1_000, 50_000, now), 0);
});

test("budgets are isolated per connection", () => {
  const now = 5_000_000;
  reserveTokens("conn-e", 9_500, now);
  assert.equal(waitMsForTokenBudget("conn-e", 10_000, 1_000, now) > 0, true);
  assert.equal(waitMsForTokenBudget("conn-f", 10_000, 1_000, now), 0);
});
