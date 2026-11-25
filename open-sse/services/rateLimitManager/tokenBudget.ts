/**
 * Per-connection TPM (tokens-per-minute) budget.
 *
 * The local limiter historically bounded only REQUESTS — rpm / minTime /
 * maxConcurrent. Providers that meter by TOKEN rate (resellers such as zunef,
 * Gemini free tier, most aggregators) answer 429 "rate_limit_error" as soon as
 * the rolling-minute token budget is spent: one 100k-token request burns it in
 * a single shot, no matter how politely the request rate is paced.
 *
 * This module is the token half of the bucket. It is intentionally pure —
 * every function takes `now` — so window behaviour is testable without sleeping.
 *
 * Budgets are opt-in: they only apply when the connection declares a `tpm`
 * override. No override means no behaviour change.
 */

const WINDOW_MS = 60_000;

type Spend = { at: number; tokens: number };

const spends = new Map<string, Spend[]>();

function prune(connectionId: string, now: number): Spend[] {
  const entries = spends.get(connectionId);
  if (!entries || entries.length === 0) return [];
  const cutoff = now - WINDOW_MS;
  let firstAlive = 0;
  while (firstAlive < entries.length && entries[firstAlive].at <= cutoff) firstAlive++;
  const alive = firstAlive > 0 ? entries.slice(firstAlive) : entries;
  if (firstAlive > 0) spends.set(connectionId, alive);
  return alive;
}

/** Tokens already reserved on this connection inside the rolling minute. */
export function tokensUsedInWindow(connectionId: string, now: number): number {
  return prune(connectionId, now).reduce((sum, entry) => sum + entry.tokens, 0);
}

/**
 * How long the caller must wait before `cost` tokens fit the budget.
 * Returns 0 when the request can go now.
 *
 * A single request larger than the whole budget is admitted once: the request
 * cannot be split, and leaving it waiting forever would deadlock the caller.
 */
export function waitMsForTokenBudget(
  connectionId: string,
  tpm: number,
  cost: number,
  now: number
): number {
  if (!Number.isFinite(tpm) || tpm <= 0) return 0;
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  if (cost > tpm) return 0;

  const entries = prune(connectionId, now);
  let used = 0;
  for (const entry of entries) used += entry.tokens;
  if (used + cost <= tpm) return 0;

  // Oldest spend frees up first — wait until enough of it has aged out.
  let needed = used + cost - tpm;
  for (const entry of entries) {
    needed -= entry.tokens;
    if (needed <= 0) {
      const freesAt = entry.at + WINDOW_MS;
      return Math.max(1, freesAt - now);
    }
  }
  return Math.max(1, WINDOW_MS);
}

/** Record `cost` tokens against the connection's rolling window. */
export function reserveTokens(connectionId: string, cost: number, now: number): void {
  if (!Number.isFinite(cost) || cost <= 0) return;
  const entries = prune(connectionId, now);
  entries.push({ at: now, tokens: cost });
  spends.set(connectionId, entries);
}

/** Test helper — drops every budget. */
export function __resetTokenBudgetsForTests(): void {
  spends.clear();
}
