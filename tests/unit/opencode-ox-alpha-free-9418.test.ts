import test from "node:test";
import assert from "node:assert/strict";

const { opencodeProvider } =
  await import("../../open-sse/config/providers/registry/opencode/index.ts");
const { opencode_zenProvider } =
  await import("../../open-sse/config/providers/registry/opencode/zen/index.ts");

const OX_ID = "x-preview-f-free";
const OX_NAME = "Ox Alpha Free (Unlimited)";

function findModel(models: { id: string }[], id: string) {
  return models.find((m) => m.id === id);
}

test("issue #9418: opencode (noauth) registry advertises Ox Alpha Free", () => {
  const ox = findModel(opencodeProvider.models, OX_ID);
  assert.ok(ox, `opencode registry is missing Ox Alpha Free "${OX_ID}"`);
  assert.equal(ox.name, OX_NAME);
  assert.equal(ox.contextLength, 1048576, "expected 1M context window");
  assert.equal(ox.maxOutputTokens, 131072, "expected 131K max output");
  assert.equal(ox.supportsVision, true, "expected multimodal (text/image/video)");
  assert.equal(ox.supportsReasoning, true, "expected reasoning-capable");
  assert.equal(
    ox.interleavedField,
    "reasoning_content",
    "expected interleaved reasoning_content contract (mandatory reasoning)"
  );
  assert.deepEqual(
    ox.supportedThinkingEfforts,
    ["low", "high", "max"],
    "expected low|high|max reasoning variants"
  );
});

test("issue #9418: opencode-zen registry advertises Ox Alpha Free with the same contract", () => {
  const ox = findModel(opencode_zenProvider.models, OX_ID);
  assert.ok(ox, `opencode-zen registry is missing Ox Alpha Free "${OX_ID}"`);
  assert.equal(ox.name, OX_NAME);
  assert.equal(ox.contextLength, 1048576);
  assert.equal(ox.maxOutputTokens, 131072);
  assert.equal(ox.supportsVision, true);
  assert.equal(ox.supportsReasoning, true);
  assert.equal(ox.interleavedField, "reasoning_content");
  assert.deepEqual(ox.supportedThinkingEfforts, ["low", "high", "max"]);
});

test("issue #9418: Ox Alpha reasoning_effort max is not normalized to xhigh", async () => {
  const { sanitizeReasoningEffortForProvider } =
    await import("../../open-sse/executors/base/reasoningEffort.ts");
  // Ox Alpha accepts {low, high, max} literally. xhigh is OmniRoute-internal and
  // must be mapped to max (top→top), never downgraded to high.
  const result = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] },
    "opencode-zen",
    OX_ID
  );
  assert.equal(
    (result as Record<string, unknown>).reasoning_effort,
    "max",
    "expected max to pass through for Ox Alpha (not normalized to xhigh)"
  );
});
