import test from "node:test";
import assert from "node:assert/strict";
import { applyQuantumLock } from "../../../open-sse/services/compression/quantumLock/quantumLockStep.ts";
import { TAIL_DELIM } from "../../../open-sse/services/compression/quantumLock/quantumPatterns.ts";
import { checkFidelity } from "../../../open-sse/services/compression/fidelityGate.ts";
import {
  recordEngineFailure,
  canRunEngine,
  recordEngineSuccess,
} from "../../../open-sse/services/compression/pipelineEngineBreaker.ts";

test("QuantumLock: stabilizes volatile UUIDs and unix timestamps in system prompt", () => {
  const body = {
    messages: [
      {
        role: "system",
        content:
          "You are an assistant. Request ID: req-9f1234ab-5678-4321-abcd-ef0123456789. Started at unix 1725928392.",
      },
      {
        role: "user",
        content: "Hello",
      },
    ],
  };

  const { body: locked, stats } = applyQuantumLock(body, { enabled: true });
  assert.ok(stats.fragments >= 2);
  const sysMsg = (locked.messages as any[])[0].content;

  // The volatile tokens in the body are replaced with stable positional placeholders
  assert.ok(sysMsg.includes("⟦Q0⟧"));
  assert.ok(sysMsg.includes("⟦Q1⟧"));
  assert.ok(sysMsg.includes(TAIL_DELIM));

  // The tail carries the exact values so nothing is lost
  assert.ok(sysMsg.includes("req-9f1234ab"));
  assert.ok(sysMsg.includes("1725928392"));
});

test("FidelityGate: accepts valid compression preserving numeric and diff hunks", () => {
  const input = [
    "Here is the git diff:",
    "@@ -10,5 +10,5 @@",
    "-const PORT = 3000;",
    "+const PORT = 8080;",
    "https://api.omniroute.ai/v1/health",
  ].join("\n");

  const output = [
    "@@ -10,5 +10,5 @@",
    "-const PORT = 3000;",
    "+const PORT = 8080;",
    "https://api.omniroute.ai/v1/health",
  ].join("\n");

  const verdict = checkFidelity(input, output, {
    enabled: true,
    checkDiffHunks: true,
    checkNumericIntegrity: true,
    minTokenSurvivalPercent: 95,
  });

  assert.equal(verdict.passed, true);
});

test("FidelityGate: rejects compression that strips diff hunks or URLs", () => {
  const input = [
    "Important diff:",
    "@@ -10,5 +10,5 @@",
    "const URL = 'https://api.omniroute.ai/v1/health';",
  ].join("\n");

  const corruptedOutput = "const URL = '';";

  const verdict = checkFidelity(input, corruptedOutput, {
    enabled: true,
    checkDiffHunks: true,
  });

  assert.equal(verdict.passed, false);
  assert.equal(verdict.failedInvariant, "protected-tokens");
});

test("PipelineCircuitBreaker: trips after threshold failures and isolates failing engine", () => {
  const engineId = "flake-engine-test";
  const cfg = {
    enabled: true,
    failureThreshold: 3,
    cooldownMs: 60000,
  };

  // Initially engine can run
  assert.equal(canRunEngine(engineId, cfg), true);

  // 1st failure
  recordEngineFailure(engineId, cfg);
  assert.equal(canRunEngine(engineId, cfg), true);

  // 2nd failure
  recordEngineFailure(engineId, cfg);
  assert.equal(canRunEngine(engineId, cfg), true);

  // 3rd failure -> Breaker trips OPEN!
  recordEngineFailure(engineId, cfg);
  assert.equal(canRunEngine(engineId, cfg), false);

  // Closing after success
  recordEngineSuccess(engineId, cfg);
  assert.equal(canRunEngine(engineId, cfg), true);
});
