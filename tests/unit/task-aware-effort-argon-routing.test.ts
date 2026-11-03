import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  getTaskSignals,
  reorderByTaskWeight,
  scoreModelForTask,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  GEMINI_WEB_MODEL_SELECTORS,
  resolveGeminiWebModelSelector,
} from "../../open-sse/executors/gemini-web/streamGenerateClient.ts";
import { gemini_webProvider } from "../../open-sse/config/providers/registry/gemini/web/index.ts";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

function makeTarget(modelStr: string, idx = 0): ResolvedComboTarget {
  const [provider = "", model = modelStr] = modelStr.includes("/")
    ? modelStr.split("/")
    : ["", modelStr];
  return {
    kind: "model" as const,
    stepId: `step-${idx}`,
    executionKey: `exec-${idx}`,
    modelStr,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

describe("Claude Code CLI v2.1.311 3-Tier Effort Extraction & Argon 4 Only Cascade", () => {
  it("registers gemini-4-argon-low, gemini-4-argon-medium, and gemini-4-argon-high in GEMINI_WEB_MODEL_SELECTORS and gemini_webProvider", () => {
    const argonHeader = '[1,null,null,null,"b1b46a6037e6aa9f",null,null,0,[4]]';
    for (const id of [
      "gemini-4-argon",
      "gemini-4-argon-low",
      "gemini-4-argon-medium",
      "gemini-4-argon-high",
    ]) {
      assert.ok(GEMINI_WEB_MODEL_SELECTORS[id], `missing selector for ${id}`);
      assert.equal(GEMINI_WEB_MODEL_SELECTORS[id].header, argonHeader);
      assert.equal(GEMINI_WEB_MODEL_SELECTORS[id].category, 1);
      assert.equal(resolveGeminiWebModelSelector(id).header, argonHeader);
    }

    const registryIds = new Set(gemini_webProvider.models.map((m) => m.id));
    for (const id of [
      "gemini-4-argon",
      "gemini-4-argon-low",
      "gemini-4-argon-medium",
      "gemini-4-argon-high",
    ]) {
      assert.ok(registryIds.has(id), `gemini_webProvider.models missing ${id}`);
    }
  });

  it("extracts effort from Claude Code CLI v2.1.311 output_config.effort, model suffixes, and model families", () => {
    assert.equal(
      getTaskSignals({
        model: "claude-opus-5-5",
        output_config: { effort: "xhigh" },
        messages: [{ role: "user", content: "implement" }],
      }).effort,
      "xhigh"
    );

    assert.equal(
      getTaskSignals({
        model: "claude-sonnet-5-5-medium",
        messages: [{ role: "user", content: "implement" }],
      }).effort,
      "medium"
    );

    assert.equal(
      getTaskSignals({
        model: "claude-haiku-5-5",
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "explore files" }],
      }).effort,
      "low",
      "haiku auxiliary/subagent model without explicit -high suffix resolves to low tier"
    );

    assert.equal(
      getTaskSignals({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "explain" }],
      }).effort,
      "medium"
    );

    assert.equal(
      getTaskSignals({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "design architecture" }],
      }).effort,
      "high"
    );
  });

  it("orders Stage 1 (Antigravity 5.5) -> Stage 2 (Zunef 5.5) -> Stage 3 (Argon 4 Only matching tier) for LOW effort", () => {
    const pool = [
      makeTarget("gemini-web/gemini-4-argon-high", 0),
      makeTarget("gemini-web/gemini-4-argon-low", 1),
      makeTarget("antigravity/gemini-4-argon-low", 2),
      makeTarget("agy/gemini-4-argon-low", 3),
      makeTarget("zunef/claude-opus-5-5", 4),
      makeTarget("zunef/claude-sonnet-5-5", 5),
      makeTarget("antigravity/claude-opus-5-5-low", 6),
      makeTarget("agy/claude-opus-5-5-low", 7),
      makeTarget("antigravity/claude-sonnet-5-5-low", 8),
      makeTarget("agy/claude-sonnet-5-5-low", 9),
    ];

    const task = classifyTask({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "quick check" }],
      tools: [{ name: "Read" }, { name: "Grep" }],
    });

    const ordered = reorderByTaskWeight(pool, task).map((t) => t.modelStr);
    assert.deepEqual(ordered.slice(0, 9), [
      "agy/claude-sonnet-5-5-low",
      "antigravity/claude-sonnet-5-5-low",
      "agy/claude-opus-5-5-low",
      "antigravity/claude-opus-5-5-low",
      "zunef/claude-sonnet-5-5",
      "zunef/claude-opus-5-5",
      "agy/gemini-4-argon-low",
      "antigravity/gemini-4-argon-low",
      "gemini-web/gemini-4-argon-low",
    ]);
  });

  it("orders Stage 1 (Antigravity 5.5) -> Stage 2 (Zunef 5.5) -> Stage 3 (Argon 4 Only matching tier) for MEDIUM effort", () => {
    const pool = [
      makeTarget("gemini-web/gemini-4-argon-low", 0),
      makeTarget("gemini-web/gemini-4-argon-medium", 1),
      makeTarget("antigravity/gemini-4-argon-medium", 2),
      makeTarget("agy/gemini-4-argon-medium", 3),
      makeTarget("zunef/claude-opus-5-5", 4),
      makeTarget("zunef/claude-sonnet-5-5", 5),
      makeTarget("antigravity/claude-opus-5-5-medium", 6),
      makeTarget("agy/claude-opus-5-5-medium", 7),
      makeTarget("antigravity/claude-sonnet-5-5-medium", 8),
      makeTarget("agy/claude-sonnet-5-5-medium", 9),
    ];

    const task = classifyTask({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "update component" }],
      tools: Array.from({ length: 6 }, (_, i) => ({ name: `tool_${i}` })),
    });

    const ordered = reorderByTaskWeight(pool, task).map((t) => t.modelStr);
    assert.deepEqual(ordered.slice(0, 9), [
      "agy/claude-sonnet-5-5-medium",
      "antigravity/claude-sonnet-5-5-medium",
      "agy/claude-opus-5-5-medium",
      "antigravity/claude-opus-5-5-medium",
      "zunef/claude-sonnet-5-5",
      "zunef/claude-opus-5-5",
      "agy/gemini-4-argon-medium",
      "antigravity/gemini-4-argon-medium",
      "gemini-web/gemini-4-argon-medium",
    ]);
  });

  it("orders Stage 1 (Antigravity 5.5) -> Stage 2 (Zunef 5.5) -> Stage 3 (Argon 4 Only matching tier) for HIGH/XHIGH/MAX effort even with tools present", () => {
    const pool = [
      makeTarget("gemini-web/gemini-4-argon-low", 0),
      makeTarget("gemini-web/gemini-4-argon-medium", 1),
      makeTarget("gemini-web/gemini-4-argon-high", 2),
      makeTarget("antigravity/gemini-4-argon-high", 3),
      makeTarget("agy/gemini-4-argon-high", 4),
      makeTarget("zunef/claude-fable-5-1", 5),
      makeTarget("zunef/claude-sonnet-5-5", 6),
      makeTarget("zunef/claude-opus-5-5", 7),
      makeTarget("antigravity/claude-sonnet-5-5-high", 8),
      makeTarget("agy/claude-sonnet-5-5-high", 9),
      makeTarget("antigravity/claude-opus-5-5-high", 10),
      makeTarget("agy/claude-opus-5-5-high", 11),
    ];

    const task = classifyTask({
      model: "claude-opus-5-5",
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "fix bug" }],
      tools: Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` })),
    });

    const ordered = reorderByTaskWeight(pool, task).map((t) => t.modelStr);
    assert.deepEqual(ordered.slice(0, 10), [
      "agy/claude-opus-5-5-high",
      "antigravity/claude-opus-5-5-high",
      "agy/claude-sonnet-5-5-high",
      "antigravity/claude-sonnet-5-5-high",
      "zunef/claude-opus-5-5",
      "zunef/claude-sonnet-5-5",
      "zunef/claude-fable-5-1",
      "agy/gemini-4-argon-high",
      "antigravity/gemini-4-argon-high",
      "gemini-web/gemini-4-argon-high",
    ]);
    assert.ok(
      scoreModelForTask("agy/gemini-4-argon-high", task) >
        scoreModelForTask("agy/gemini-4-argon-low", task),
      "argon-high must outscore argon-low on high/xhigh effort even when tools are present"
    );
  });

  it("allows reasoning_effort on Direct HTTP Argon 4 models in GeminiWebExecutor while keeping Playwright #9356 guard intact", async () => {
    const result = await new GeminiWebExecutor().execute({
      model: "gemini-4-argon-high",
      body: {
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      stream: false,
      credentials: {},
      signal: AbortSignal.timeout(5000),
      log: null,
    });
    // Reaches the missing-cookie 401 check instead of the #9356 400 capability rejection
    assert.equal(result.response.status, 401);
  });
});
