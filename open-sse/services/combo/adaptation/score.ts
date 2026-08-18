/**
 * Pure scoring + quarantine math for the Auto-Combo Adaptation Engine.
 *
 * Purpose: maintain a slowly-learning quality score per (combo, provider) pair
 * so the auto strategy can prefer providers that have historically succeeded
 * and quarantine providers that keep failing. The learned score is an EMA
 * (exponential moving average) over request outcomes — success pulls it toward
 * 1.0, failure toward 0.0, and a slow alpha (SCORE_ALPHA = 0.1) means a single
 * transient error does not destroy a hard-won reputation. Successes that are
 * pathologically slow relative to the running latency baseline receive an
 * additional penalty so a sluggish provider does not keep winning purely on
 * availability.
 *
 * Design constraints
 * ──────────────────
 *  - PURE FUNCTIONS ONLY — no DB imports, no module state, no I/O, no throws.
 *    Every function is deterministic: identical inputs always yield identical
 *    outputs. The DB table `combo_adaptation_state` (UNIQUE(combo_id,
 *    provider_id), learned_score REAL DEFAULT 0.5, request_count,
 *    success_count, avg_latency_ms, last_failure_at, excluded_until,
 *    updated_at) is read/written exclusively by the stateful sibling module;
 *    this leaf only transforms numbers. This keeps the scoring logic trivially
 *    unit-testable and impossible to corrupt via caller error paths.
 *  - Fail-open philosophy: these helpers never throw and never return NaN for
 *    any finite input — the clamped [MIN_SCORE, 1.0] / >= 0 ranges guarantee a
 *    usable value even for degenerate inputs, so a buggy caller cannot block a
 *    request.
 *  - Emits ms-epoch timestamps (number) for time fields so the persisted state
 *    shape stays comparable with Date.now() values used across combo/* leaves.
 *
 * No barrel import — consistent with the other combo/* leaves.
 */

/** EMA decay factor — how much a single outcome moves the learned score (slow by design). */
export const SCORE_ALPHA = 0.1 as const;

/** Floor for learned scores — a provider never scores lower than this. */
export const MIN_SCORE = 0.05 as const;

/** Below this score a provider becomes eligible for quarantine. */
export const QUARANTINE_SCORE_THRESHOLD = 0.2 as const;

/** Minimum consecutive failures required before quarantine can apply. */
export const QUARANTINE_MIN_FAILURES = 3 as const;

/** Quarantine duration for an excluded provider (5 minutes). */
export const QUARANTINE_WINDOW_MS = 300_000 as const;

/** Latency ratio threshold — only penalize when ratio is strictly above this. */
export const LATENCY_PENALTY_RATIO = 2 as const;

/** Maximum latency penalty applied per success (fraction of the score). */
export const LATENCY_PENALTY_MAX = 0.3 as const;

/**
 * Persisted shape of one (combo, provider) adaptation record, mirroring the
 * `combo_adaptation_state` table. Times are epoch ms (number), consistent with
 * Date.now() usage across combo/* leaves.
 */
export interface AdaptationState {
  /** Combo id the score belongs to. */
  comboId: string;
  /** Provider id the score belongs to. */
  providerId: string;
  /** EMA-learned quality score in [MIN_SCORE, 1.0] (default 0.5). */
  learnedScore: number;
  /** Total requests observed for this pair. */
  requestCount: number;
  /** Successful requests observed for this pair. */
  successCount: number;
  /** EMA of successful latencies (ms) — used as the penalty baseline. */
  avgLatencyMs: number;
  /** Consecutive failures — reset to 0 on success. */
  consecutiveFailures: number;
  /** Epoch ms until which the provider is excluded, or null when not quarantined. */
  excludedUntilMs: number | null;
  /** Epoch ms of the last state write. */
  updatedAt: number;
}

/**
 * EMA update of the learned score from one request outcome.
 *
 *  - success: score = (1 - alpha) * score + alpha * 1.0
 *  - failure: score = (1 - alpha) * score + alpha * 0.0
 *
 * On success only, when a positive latency baseline exists, a latency penalty
 * is applied: ratio = latencyMs / baselineMs; if ratio > LATENCY_PENALTY_RATIO,
 * penalty = min((ratio - LATENCY_PENALTY_RATIO) / 3, 1.0) * LATENCY_PENALTY_MAX
 * and score = max(score - penalty, MIN_SCORE). The final result is clamped to
 * [MIN_SCORE, 1.0].
 */
export function computeScore(
  current: number,
  outcome: "success" | "failure",
  latencyMs: number,
  baselineMs: number
): number {
  const decayed =
    outcome === "success"
      ? (1 - SCORE_ALPHA) * current + SCORE_ALPHA * 1.0
      : (1 - SCORE_ALPHA) * current + SCORE_ALPHA * 0.0;

  let score = decayed;

  if (outcome === "success" && baselineMs > 0) {
    const ratio = latencyMs / baselineMs;
    if (ratio > LATENCY_PENALTY_RATIO) {
      const penalty = Math.min((ratio - LATENCY_PENALTY_RATIO) / 3, 1.0) * LATENCY_PENALTY_MAX;
      score = Math.max(score - penalty, MIN_SCORE);
    }
  }

  return Math.min(1.0, Math.max(MIN_SCORE, score));
}

/**
 * EMA of the latency baseline, used as the reference for the success latency
 * penalty. Only successes update the baseline (failures carry no latency
 * signal worth trusting). With no baseline yet (currentBaselineMs <= 0) a
 * success seeds the baseline directly with its own latency.
 */
export function computeBaseline(
  currentBaselineMs: number,
  latencyMs: number,
  outcome: "success" | "failure"
): number {
  if (outcome !== "success") return currentBaselineMs;
  if (currentBaselineMs <= 0) return latencyMs;
  return (1 - SCORE_ALPHA) * currentBaselineMs + SCORE_ALPHA * latencyMs;
}

/**
 * Quarantine decision: a provider is quarantined only when its learned score
 * has dropped below QUARANTINE_SCORE_THRESHOLD AND it has produced at least
 * QUARANTINE_MIN_FAILURES consecutive failures — a single bad streak on a
 * previously strong provider must not trip it.
 */
export function shouldQuarantine(score: number, consecutiveFailures: number): boolean {
  return score < QUARANTINE_SCORE_THRESHOLD && consecutiveFailures >= QUARANTINE_MIN_FAILURES;
}

/**
 * Fold the learned score into a routing weight. The score can only reduce or
 * hold a weight (never increase it); the result is clamped to >= 0 so a
 * negative or NaN score can never produce a negative routing weight.
 */
export function applyScoreToWeight(weight: number, score: number): number {
  return Math.max(0, weight * score);
}
