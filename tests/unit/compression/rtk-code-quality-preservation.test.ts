import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processRtkText } from "../../../open-sse/services/compression/engines/rtk/index.ts";
import { stripCode } from "../../../open-sse/services/compression/engines/rtk/codeStripper.ts";
import { matchRtkFilter } from "../../../open-sse/services/compression/engines/rtk/filterLoader.ts";

describe("RTK Code Quality Preservation & Token Minimization", () => {
  it("never truncates code files when reading with cat/view/head commands", () => {
    // 100 lines of source code containing Error references
    const lines = [
      "import { CustomError } from './errors';",
      "export class NetworkService {",
      "  constructor() {",
      "    console.log('init');",
      "  }",
    ];
    for (let i = 0; i < 90; i++) {
      lines.push(`  step_${i}() { if (Math.random() < 0.1) throw new Error('step ${i} failed'); }`);
    }
    lines.push("}");
    const code = lines.join("\n");

    const result = processRtkText(code, { command: "cat src/service.ts" });
    assert.equal(result.text, code, "Code file must not be modified or truncated during cat read");
    assert.equal(result.text.includes("[rtk:truncated"), false);
  });

  it("preserves compiler & linter directives when comments are stripped", () => {
    const codeWithDirectives = [
      "// normal comment that should be stripped",
      "// @ts-ignore - necessary due to upstream type mismatch",
      "const a: any = 1;",
      "// eslint-disable-next-line @typescript-eslint/no-unused-vars",
      "const b = 2;",
      "// TODO: refactor this method later",
      "function test() { return true; }",
    ].join("\n");

    const stripped = stripCode(codeWithDirectives, "typescript", { removeComments: true });
    assert.ok(
      stripped.text.includes("// @ts-ignore"),
      "@ts-ignore must be preserved to prevent compiler errors"
    );
    assert.ok(
      stripped.text.includes("// eslint-disable-next-line"),
      "eslint directive must be preserved"
    );
    assert.ok(stripped.text.includes("// TODO:"), "TODO note must be preserved");
    assert.ok(
      !stripped.text.includes("// normal comment that should be stripped"),
      "Non-directive comments should be stripped"
    );
  });

  it("does not allow command-specific filters to hijack unrelated commands via pattern match", () => {
    const nodeTestOutput = [
      "▶ suite",
      "  ✖ test failed",
      "    AssertionError [ERR_ASSERTION]: Expected 1 to be 2",
      "exit code: 1",
    ].join("\n");

    const matched = matchRtkFilter(nodeTestOutput, "node --test");
    // Should match test-node, NOT docker-build (even though docker-build has 'exit code: \\d+')
    assert.equal(matched?.id, "test-node");
  });

  it("collapses all-green Node.js test output when renderers are enabled", () => {
    const greenOutput = [
      "▶ suite",
      "  ✔ test 1 (1.2ms)",
      "  ✔ test 2 (0.8ms)",
      "ℹ tests 2",
      "ℹ suites 1",
      "ℹ pass 2",
      "ℹ fail 0",
    ].join("\n");

    const result = processRtkText(greenOutput, {
      command: "node --test",
      config: { enableRenderers: true, renderers: ["test-node"] },
    });

    assert.ok(result.text.includes("✓ Node Test: 2 passed"));
    assert.ok(result.techniquesUsed.includes("rtk-render:test-green"));
  });

  it("preserves 100% failure diagnostics when test runner fails", () => {
    const failedOutput = [
      "▶ suite",
      "  ✖ test 1 (1.2ms)",
      "    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      "    + actual - expected",
      "    + 1",
      "    - 2",
      "      at TestContext.<anonymous> (tests/unit/math.test.ts:10:12)",
      "  ✔ test 2 (0.8ms)",
      "ℹ tests 2",
      "ℹ fail 1",
    ].join("\n");

    const result = processRtkText(failedOutput, {
      command: "node --test",
      config: { enableRenderers: true, renderers: ["test-node"] },
    });

    // Failing test must NEVER be rendered down to 1 summary line
    assert.ok(!result.techniquesUsed.includes("rtk-render:test-green"));
    assert.ok(result.text.includes("✖ test 1"));
    assert.ok(result.text.includes("AssertionError"));
    assert.ok(result.text.includes("+ actual - expected"));
    assert.ok(result.text.includes("at TestContext"));
    assert.ok(result.text.includes("ℹ fail 1"));
    // Passing noise is stripped
    assert.ok(!result.text.includes("✔ test 2"));
  });

  it("collapses all-green Go test output when renderers are enabled", () => {
    const greenGoOutput = [
      "=== RUN   TestRouter",
      "--- PASS: TestRouter (0.02s)",
      "=== RUN   TestCache",
      "--- PASS: TestCache (0.01s)",
      "PASS",
      "ok  \tgithub.com/omniroute/pkg/router\t0.035s",
      "ok  \tgithub.com/omniroute/pkg/cache\t0.022s",
    ].join("\n");

    const result = processRtkText(greenGoOutput, {
      command: "go test ./...",
      config: { enableRenderers: true, renderers: ["test-go"] },
    });

    assert.ok(result.text.includes("✓ Go Test: ok (2 packages)"));
    assert.ok(result.techniquesUsed.includes("rtk-render:test-green"));
  });

  it("collapses clean TypeScript/ESLint output with zero errors", () => {
    const cleanOutput = "";

    const result = processRtkText(cleanOutput, {
      command: "tsc --noEmit",
      config: { enableRenderers: true, renderers: ["build-typescript"] },
    });

    assert.ok(result.text.includes("0 problems found"));
    assert.ok(result.techniquesUsed.includes("rtk-render:test-green"));
  });
});
