import type { RenderResult, CommandDetectionResult } from "./types.ts";
import { NO_RENDER } from "./types.ts";

/**
 * RTK semantic renderer for test suite output (pytest, jest, vitest, eslint).
 *
 * CRITICAL safety guard: only collapses when output indicates TOTAL success.
 * ANY sign of failure forces a no-op to preserve full diagnostics.
 *
 * Failure signals (force no-op):
 *  - /\bFAIL\b/ in the text
 *  - /failed/i paired with a nonzero count (e.g. "1 failed")
 *  - ✖ symbol
 *  - "Error" anywhere
 *  - "Traceback" (Python)
 *  - "AssertionError"
 *
 * When green, extract the summary line and return it.
 * If no recognizable summary line is found, no-op.
 */
export function renderTestGreen(text: string, _detection: CommandDetectionResult): RenderResult {
  // Strip ANSI color codes before applying the failure guards. jest/vitest emit a
  // colored "FAIL" status whose preceding ANSI byte ("m" of [31m) is a word
  // character, defeating a /\bFAIL\b/ boundary on the raw string. Guards run on the
  // stripped copy; the original `text` is what we return on a no-op (lossless).
  const stripped = text.replace(/\[[0-9;]*m/g, "");

  // Failure guard — must check FIRST; never weaken
  if (/\bFAIL\b/.test(stripped)) return NO_RENDER(text);
  if (/✖/.test(stripped)) return NO_RENDER(text);
  if (/Error/.test(stripped)) return NO_RENDER(text);
  if (/Traceback/.test(stripped)) return NO_RENDER(text);
  if (/AssertionError/.test(stripped)) return NO_RENDER(text);

  // "failed" with a nonzero count, e.g. "1 failed" or "failed: 3"
  const failedMatch = stripped.match(/(\d+)\s+failed/i) ?? stripped.match(/failed[:\s]+(\d+)/i);
  if (failedMatch && parseInt(failedMatch[1], 10) > 0) return NO_RENDER(text);

  // Try to extract a recognised summary line (from the stripped copy → ANSI-free)
  const summary = extractSummaryLine(stripped);
  if (!summary) return NO_RENDER(text);

  return { text: summary, changed: true, renderer: "test-green" };
}

function extractSummaryLine(text: string): string | null {
  const lines = text.split("\n");

  // pytest: === N passed in X.Xs ===  (also handles variants like  === N passed, M warning ===)
  for (const line of lines) {
    if (/={3,}\s+\d+\s+passed/.test(line)) return line.trim();
  }

  // jest: "Tests: N passed, N total" or "Test Suites: ... Tests: ..."
  for (const line of lines) {
    if (/Tests:\s+\d+\s+passed/.test(line)) return line.trim();
  }

  // vitest: "Tests  N passed (N)" or "Test Files  N passed (N)"
  const vitestTests = lines.find((l) => /^\s*Tests\s+\d+\s+passed/i.test(l));
  const vitestFiles = lines.find((l) => /^\s*Test Files\s+\d+\s+passed/i.test(l));
  if (vitestTests) {
    return `✓ Vitest: ${vitestFiles ? vitestFiles.trim() + ", " : ""}${vitestTests.trim()}`;
  }

  // vitest / jest run summary line: "✓ N tests passed"
  for (const line of lines) {
    if (/\d+\s+tests?\s+passed/i.test(line)) return line.trim();
  }

  // Node.js native test runner: "# pass N" or "ℹ pass N"
  const nodePass = lines.find((l) => /^[#ℹ]\s*pass\s+\d+/i.test(l.trim()));
  if (nodePass) {
    const match = nodePass.match(/\bpass\s+(\d+)/i);
    return `✓ Node Test: ${match ? match[1] : ""} passed`.trim();
  }

  // mocha: "N passing (Xs)"
  for (const line of lines) {
    if (/^\s*\d+\s+passing\b/i.test(line)) return `✓ ${line.trim()}`;
  }

  // cargo test: "test result: ok. N passed; 0 failed; ..."
  for (const line of lines) {
    if (/test result:\s+ok\.\s+\d+\s+passed/i.test(line)) return `✓ ${line.trim()}`;
  }

  // go test: "PASS" and lines like "ok  <package>  0.123s"
  if (text.includes("PASS") || lines.some((l) => /^ok\s+\S+\s+[\d.]+s/i.test(l.trim()))) {
    const okLines = lines.filter((l) => /^ok\s+\S+\s+[\d.]+s/i.test(l.trim()));
    if (okLines.length > 0) {
      return `✓ Go Test: ok (${okLines.length} package${okLines.length > 1 ? "s" : ""})`;
    }
  }

  // eslint / build-eslint / build-typescript: empty output = clean; if we reach here with no failures, synthesize
  if (text.trim() === "" || text.trim().startsWith("\n")) {
    return "ESLint / TypeScript: 0 problems found";
  }

  return null;
}
