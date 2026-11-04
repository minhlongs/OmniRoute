/**
 * A pinned fallback target must never be started early as a hedge sibling.
 *
 * Evidence from production: the newly added Antigravity account (`a5df266a`)
 * logged 41 x 499 in 30 minutes — every one of them `disconnect: hedge-cancelled`.
 * The account was healthy; hedging started it and cancelled it because another
 * target answered first. That burns its quota and makes a healthy account look
 * broken in the error rate.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { canHedgeInto } = await import("../../open-sse/services/combo/comboAttemptLoop.ts");

test("a normal target can be hedged into", () => {
  assert.equal(canHedgeInto({}), true);
  assert.equal(canHedgeInto({ noHedge: false }), true);
});

test("a fallback-only target refuses to be hedged into", () => {
  assert.equal(canHedgeInto({ noHedge: true }), false);
});

test("a missing next target keeps the historical behaviour", () => {
  assert.equal(canHedgeInto(undefined), true);
  assert.equal(canHedgeInto(null), true);
});
