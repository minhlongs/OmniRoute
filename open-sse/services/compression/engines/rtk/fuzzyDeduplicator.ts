/**
 * Fuzzy deduplication for RTK: collapse near-duplicate lines using token similarity.
 *
 * Two lines are "near-duplicates" when >=80% of their non-trivial tokens overlap.
 * This catches file listings, log outputs, and repeated structures that differ by
 * only a few tokens (e.g. different filenames, different line numbers).
 *
 * Complexity: O(n * w) where w = sliding window size (default 20).
 */
export interface FuzzyDedupOptions {
  /** Minimum token overlap ratio (0-1) to consider lines near-duplicates. Default 0.8 */
  similarityThreshold?: number;
  /** Sliding window size for pairwise comparison. Default 20 */
  windowSize?: number;
}

const TRIVIAL_TOKEN_RE = /^\d+$/; // pure numbers are trivial
const TOKEN_RE = /\S+/g;

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    const t = m[0].toLowerCase();
    // skip pure numbers (line numbers, timestamps, byte counts)
    if (TRIVIAL_TOKEN_RE.test(t)) continue;
    // skip very short tokens (< 3 chars)
    if (t.length < 3) continue;
    tokens.push(t);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fuzzy-deduplicate lines in text. Returns the compressed text and number of
 * lines collapsed.
 */
export function fuzzyDeduplicateLines(
  text: string,
  options: FuzzyDedupOptions = {}
): { text: string; collapsed: number } {
  const threshold = options.similarityThreshold ?? 0.8;
  const windowSize = options.windowSize ?? 20;

  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let collapsed = 0;

  // Pre-tokenize all lines
  const tokenCache: { tokens: string[]; tokenSet: Set<string> }[] = [];
  for (const line of lines) {
    const tokens = tokenize(line);
    tokenCache.push({ tokens, tokenSet: new Set(tokens) });
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const { tokenSet: curSet } = tokenCache[i];

    // Skip trivially short lines (< 3 non-trivial tokens)
    if (curSet.size < 3) {
      output.push(line);
      i++;
      continue;
    }

    // Check lines ahead in the sliding window for near-duplicates
    let runLength = 1;
    while (runLength < windowSize && i + runLength < lines.length) {
      const { tokenSet: nextSet } = tokenCache[i + runLength];

      // Quick size check: if token counts differ by >2x, skip
      if (nextSet.size > curSet.size * 2 || curSet.size > nextSet.size * 2) {
        break;
      }

      // Only compare non-trivial token sets
      if (nextSet.size < 3) break;

      const sim = jaccard(curSet, nextSet);
      if (sim >= threshold) {
        runLength++;
      } else {
        break;
      }
    }

    if (runLength >= 3) {
      // Collapse: keep first line + summary
      output.push(line);
      output.push("[fuzzy: " + (runLength - 1) + " similar lines collapsed]");
      collapsed += runLength - 1;
      i += runLength;
    } else {
      output.push(line);
      i++;
    }
  }

  return { text: output.join("\n"), collapsed };
}
