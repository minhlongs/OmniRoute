/**
 * Persistence + runtime counters for the Auto-Combo Adaptation Engine.
 *
 * Purpose: give the auto strategy a durable memory of per-provider quality.
 * The sibling pure-scoring leaf (`./score.ts`) turns one request outcome into
 * a new learned score / latency baseline / quarantine decision; this leaf owns
 * the state around it: the `combo_adaptation_state` SQLite table plus an
 * in-memory entry/counter cache that keeps the routing hot path DB-free.
 *
 * NOTE: this is the real implementation (authored by the adaptation store
 * agent), replacing the temporary verification stub the combo.ts wiring agent
 * placed here — same exported signatures, so wiring typechecks are unaffected.
 *
 * Design constraints
 * ──────────────────
 *  - Fail-open: every public function catches its own errors and returns safe
 *    defaults (empty Map, empty Set, 0, no-op). A bug in this store must NEVER
 *    block a request — the worst case is a stale learned score, which the auto
 *    strategy treats as advisory anyway.
 *  - Persist-on-failure only: `recordOutcome` writes the row immediately when
 *    the outcome is a failure (plan decision D1). Successes only bump
 *    in-memory counters; the periodic flush (60s, best-effort) folds them into
 *    the DB. A crashed process loses at most one flush window of success
 *    counters — acceptable, mirroring the failureTracker philosophy.
 *  - Module-level singleton with TTL + size-capped eviction (30 min
 *    inactivity, MAX_ENTRIES = 2000, oldest evicted first) so long-lived
 *    processes stay bounded.
 *  - Consecutive-failure tracking lives in memory only (like failureTracker) —
 *    acceptable to lose on restart.
 *  - Times: `AdaptationState` and in-memory fields are epoch ms (number,
 *    matching ./score.ts); DB TEXT columns (`excluded_until`,
 *    `last_failure_at`, `updated_at`) are ISO-8601 strings converted at the
 *    boundary.
 *  - No barrel import — consistent with the other combo/* leaves. The score
 *    leaf is imported directly; DB access follows the sibling combo/* idiom
 *    (deferred dynamic import of the canonical `src/lib/db/core` module —
 *    same shape as applyStrategyOrdering.ts's `await import(...localDb)`).
 */

import { computeBaseline, computeScore, QUARANTINE_WINDOW_MS, shouldQuarantine } from "./score.ts";
import type { AdaptationState } from "./score.ts";

/** Periodic flush interval for in-memory success counters (60s). */
export const ADAPTATION_FLUSH_INTERVAL_MS = 60_000 as const;

/** TTL for in-memory entries — evicted after 30 min of inactivity. */
const INACTIVITY_TTL_MS = 30 * 60 * 1000;

/** Hard cap to prevent unbounded growth in pathological traffic patterns. */
const MAX_ENTRIES = 2_000;

/** Default learned score when no history exists (matches the DB column default). */
const DEFAULT_LEARNED_SCORE = 0.5;

/** Runtime state for one (combo, provider) pair. Mirrors the table + score.ts. */
interface MemoryEntry {
  comboId: string;
  providerId: string;
  learnedScore: number;
  /** EMA of successful latencies (ms) — doubles as the scoring latency baseline. */
  avgLatencyMs: number;
  requestCount: number;
  successCount: number;
  consecutiveFailures: number;
  /** Epoch ms until which the provider is excluded, or null when not quarantined. */
  excludedUntilMs: number | null;
  /** Epoch ms of the last failure, or null (cleared on success). */
  lastFailureAtMs: number | null;
  /** Epoch ms of the last state mutation. */
  updatedAt: number;
  /** Epoch ms of the last read/write touch — drives TTL eviction. */
  lastActivityAt: number;
  /** True when the in-memory state has not been persisted yet. */
  dirty: boolean;
}

/** Minimal statement surface — mirrors the cast used in db/contextHandoffs.ts. */
interface StatementLike<TRow = unknown> {
  get: (...params: unknown[]) => TRow | undefined;
  all: (...params: unknown[]) => TRow[];
  run: (...params: unknown[]) => { changes: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

type RowToCamel = (row: unknown) => Record<string, unknown> | null;

/** Both helpers fetched in one deferred import of the canonical db module. */
interface DbAccess {
  db: DbLike;
  rowToCamel: RowToCamel;
}

const UPSERT_SQL = `
INSERT INTO combo_adaptation_state (
  combo_id, provider_id, learned_score, request_count, success_count,
  avg_latency_ms, last_failure_at, excluded_until, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(combo_id, provider_id) DO UPDATE SET
  learned_score = excluded.learned_score,
  request_count = excluded.request_count,
  success_count = excluded.success_count,
  avg_latency_ms = excluded.avg_latency_ms,
  last_failure_at = excluded.last_failure_at,
  excluded_until = excluded.excluded_until,
  updated_at = excluded.updated_at
`;

const LOAD_SQL = `
SELECT combo_id, provider_id, learned_score, request_count, success_count,
       avg_latency_ms, last_failure_at, excluded_until, updated_at
FROM combo_adaptation_state
WHERE combo_id = ?
`;

const EXCLUDED_SQL = `
SELECT provider_id, excluded_until
FROM combo_adaptation_state
WHERE combo_id = ? AND excluded_until IS NOT NULL AND excluded_until > ?
`;

/** Module-level singleton state map, keyed `${comboId}::${providerId}`. */
const stateMap = new Map<string, MemoryEntry>();

/** Periodic flush timer — started lazily by the first recordOutcome. */
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Pure keying helper — keeps the lookup format in one place. */
function keyOf(comboId: string, providerId: string): string {
  return `${comboId}::${providerId}`;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toEpochMs(value: unknown, fallback: number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Evict expired entries (30 min inactivity) + enforce the hard cap (oldest
 * by lastActivityAt first). Called lazily on every mutation/read so no
 * background timer is needed. Dirty entries may be evicted before their flush —
 * worst case a few success counters are lost, which is acceptable by design.
 */
function evict(now: number): void {
  for (const [key, entry] of stateMap) {
    if (now - entry.lastActivityAt > INACTIVITY_TTL_MS) stateMap.delete(key);
  }
  while (stateMap.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestActivity = Infinity;
    for (const [key, entry] of stateMap) {
      if (entry.lastActivityAt < oldestActivity) {
        oldestActivity = entry.lastActivityAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    stateMap.delete(oldestKey);
  }
}

/**
 * Canonical DB access: deferred dynamic import of `src/lib/db/core` (the
 * `getDbInstance()` singleton + `rowToCamel`), matching the dynamic-import
 * idiom the sibling combo/* leaves use for localDb access. Never throws —
 * callers treat failure as "DB unavailable" and fall back to memory-only
 * behavior.
 */
async function getDb(): Promise<DbAccess> {
  const { getDbInstance, rowToCamel } = await import("../../../../src/lib/db/core");
  return { db: getDbInstance() as unknown as DbLike, rowToCamel };
}

/** Single-statement upsert of an entry's full current state. Returns success. */
function writeEntry(db: DbLike, entry: MemoryEntry): boolean {
  try {
    db.prepare(UPSERT_SQL).run(
      entry.comboId,
      entry.providerId,
      entry.learnedScore,
      entry.requestCount,
      entry.successCount,
      entry.avgLatencyMs,
      toIso(entry.lastFailureAtMs),
      toIso(entry.excludedUntilMs),
      toIso(entry.updatedAt)
    );
    return true;
  } catch {
    return false;
  }
}

/** Best-effort immediate persist (failure path). Never throws. */
async function persistEntry(entry: MemoryEntry): Promise<void> {
  try {
    const { db } = await getDb();
    writeEntry(db, entry);
  } catch {
    // Fail-open — the entry stays dirty so the periodic flush retries.
  }
}

/** Convert a raw (snake_case) DB row into a seeded memory entry. */
function entryFromRow(
  row: unknown,
  comboId: string,
  now: number,
  rowToCamel: RowToCamel
): MemoryEntry | null {
  const camel = rowToCamel(row);
  if (!camel) return null;
  const providerId = typeof camel.providerId === "string" ? camel.providerId : "";
  if (!providerId) return null;
  return {
    comboId,
    providerId,
    learnedScore: toFiniteNumber(camel.learnedScore, DEFAULT_LEARNED_SCORE),
    avgLatencyMs: toFiniteNumber(camel.avgLatencyMs, 0),
    requestCount: Math.max(0, Math.trunc(toFiniteNumber(camel.requestCount, 0))),
    successCount: Math.max(0, Math.trunc(toFiniteNumber(camel.successCount, 0))),
    // Consecutive failures are memory-only by design (see file header).
    consecutiveFailures: 0,
    excludedUntilMs: toEpochMs(camel.excludedUntil, null),
    lastFailureAtMs: toEpochMs(camel.lastFailureAt, null),
    updatedAt: toEpochMs(camel.updatedAt, now) as number,
    lastActivityAt: now,
    dirty: false,
  };
}

function toAdaptationState(entry: MemoryEntry): AdaptationState {
  return {
    comboId: entry.comboId,
    providerId: entry.providerId,
    learnedScore: entry.learnedScore,
    requestCount: entry.requestCount,
    successCount: entry.successCount,
    avgLatencyMs: entry.avgLatencyMs,
    consecutiveFailures: entry.consecutiveFailures,
    excludedUntilMs: entry.excludedUntilMs,
    updatedAt: entry.updatedAt,
  };
}

/** Lazily start the periodic counter flush. Idempotent, never throws. */
function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  try {
    flushTimer = setInterval(() => {
      void flushCounters();
    }, ADAPTATION_FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for the flush; guarded so non-Node
    // runtimes (e.g. Cloudflare Workers) that lack unref() still work.
    if (typeof flushTimer === "object" && "unref" in flushTimer) {
      (flushTimer as { unref?: () => void }).unref?.();
    }
  } catch {
    flushTimer = null;
  }
}

/**
 * Load every persisted adaptation row for a combo, merged with the fresher
 * in-memory view where one exists (success counters that have not been flushed
 * yet must not be clobbered by stale DB rows). Rows are also seeded into the
 * in-memory cache so subsequent recordOutcome calls start from persisted state.
 *
 * Fail-open: returns an empty Map on any error — the auto strategy then falls
 * back to default scores (0.5) instead of blocking the request.
 *
 * @returns Map keyed by providerId.
 */
export async function loadAdaptationScores(comboId: string): Promise<Map<string, AdaptationState>> {
  try {
    const now = Date.now();
    evict(now);
    const result = new Map<string, AdaptationState>();
    try {
      const { db, rowToCamel } = await getDb();
      const rows = db.prepare(LOAD_SQL).all(comboId);
      for (const row of rows) {
        const seeded = entryFromRow(row, comboId, now, rowToCamel);
        if (!seeded) continue;
        const existing = stateMap.get(keyOf(comboId, seeded.providerId));
        if (existing) {
          // In-memory view is fresher (unflushed success counters, live
          // consecutive failures) — surface it and keep it warm.
          existing.lastActivityAt = now;
          result.set(existing.providerId, toAdaptationState(existing));
        } else {
          stateMap.set(keyOf(comboId, seeded.providerId), seeded);
          result.set(seeded.providerId, toAdaptationState(seeded));
        }
      }
    } catch {
      // DB unavailable — fall through to the in-memory view only.
    }
    // Memory-only entries (successes recorded before their first flush) round
    // out the map.
    for (const [key, entry] of stateMap) {
      if (entry.comboId !== comboId) continue;
      if (!result.has(entry.providerId)) result.set(entry.providerId, toAdaptationState(entry));
    }
    return result;
  } catch {
    return new Map<string, AdaptationState>();
  }
}

/**
 * Fold one request outcome into the learned state for a (combo, provider)
 * pair: new score via computeScore, new latency baseline via computeBaseline,
 * consecutive-failure tracking in memory (reset on success, incremented on
 * failure), and a quarantine decision via shouldQuarantine — when true,
 * excluded_until = now + QUARANTINE_WINDOW_MS (5 min).
 *
 * Persistence policy (plan decision D1):
 *  - FAILURE → upsert the row immediately (async, best-effort, never throws).
 *  - SUCCESS → in-memory counters only, marked dirty for the periodic flush.
 *    The 60s flush timer is started by the first call to this function.
 *
 * `scoreBefore` / `baselineMs` seed a cold start (no in-memory entry yet, e.g.
 * after a restart) so the store continues from the values the auto strategy
 * used at decision time. When an in-memory entry already exists, its own
 * fresher values are used instead. Fail-open: never rejects.
 */
export async function recordOutcome(
  comboId: string,
  providerId: string,
  outcome: "success" | "failure",
  latencyMs: number,
  scoreBefore: number,
  baselineMs: number
): Promise<void> {
  try {
    const now = Date.now();
    evict(now);
    ensureFlushTimer();
    const key = keyOf(comboId, providerId);
    const existing = stateMap.get(key);
    const currentScore = existing ? existing.learnedScore : scoreBefore;
    const currentBaseline = existing ? existing.avgLatencyMs : baselineMs;
    const consecutiveFailures =
      outcome === "failure" ? (existing?.consecutiveFailures ?? 0) + 1 : 0;
    const learnedScore = computeScore(currentScore, outcome, latencyMs, currentBaseline);
    const avgLatencyMs = computeBaseline(currentBaseline, latencyMs, outcome);
    const excludedUntilMs = shouldQuarantine(learnedScore, consecutiveFailures)
      ? now + QUARANTINE_WINDOW_MS
      : null;
    const entry: MemoryEntry = {
      comboId,
      providerId,
      learnedScore,
      avgLatencyMs,
      requestCount: (existing?.requestCount ?? 0) + 1,
      successCount: (existing?.successCount ?? 0) + (outcome === "success" ? 1 : 0),
      consecutiveFailures,
      excludedUntilMs,
      lastFailureAtMs: outcome === "failure" ? now : null,
      updatedAt: now,
      lastActivityAt: now,
      dirty: true,
    };
    stateMap.set(key, entry);
    if (outcome === "failure") {
      // D1: failures persist immediately. The entry stays dirty so the
      // periodic flush re-writes idempotently and retries on failure.
      await persistEntry(entry);
    }
  } catch {
    // Fail-open — a store bug must never propagate into the routing path.
  }
}

/**
 * Provider ids currently excluded for a combo (excluded_until > now), from the
 * in-memory view plus a DB query covering rows not loaded into memory yet.
 * Expired exclusions found in memory are lazily cleared and marked dirty so
 * the next flush corrects the DB row.
 *
 * Fail-open: returns an empty Set on any error.
 */
export async function getExcludedProviders(comboId: string): Promise<Set<string>> {
  try {
    const now = Date.now();
    evict(now);
    const excluded = new Set<string>();
    const inMemory = new Set<string>();
    for (const entry of stateMap.values()) {
      if (entry.comboId !== comboId) continue;
      inMemory.add(entry.providerId);
      if (entry.excludedUntilMs === null) continue;
      if (entry.excludedUntilMs > now) {
        excluded.add(entry.providerId);
      } else {
        // Lazy self-heal: an expired exclusion is stale state — clear it and
        // mark dirty so the next flush persists the correction.
        entry.excludedUntilMs = null;
        entry.dirty = true;
      }
    }
    try {
      const { db, rowToCamel } = await getDb();
      // ISO strings sort chronologically, but re-validate in JS anyway so a
      // row written with a different TEXT format can never exclude wrongly.
      const rows = db.prepare(EXCLUDED_SQL).all(comboId, toIso(now));
      for (const row of rows) {
        const camel = rowToCamel(row);
        if (!camel) continue;
        const providerId = typeof camel.providerId === "string" ? camel.providerId : "";
        if (!providerId || inMemory.has(providerId)) continue;
        const excludedUntilMs = toEpochMs(camel.excludedUntil, null);
        if (excludedUntilMs !== null && excludedUntilMs > now) {
          excluded.add(providerId);
        }
      }
    } catch {
      // DB unavailable — the in-memory view is still authoritative for what
      // it holds.
    }
    return excluded;
  } catch {
    return new Set<string>();
  }
}

/**
 * Read-only peek at the in-memory consecutive-failure count for a
 * (combo, provider) pair. Returns 0 when unknown or TTL-expired. Sync + never
 * throws — safe for hot-path quarantine checks.
 */
export function getConsecutiveFailures(comboId: string, providerId: string): number {
  try {
    const entry = stateMap.get(keyOf(comboId, providerId));
    if (!entry) return 0;
    if (Date.now() - entry.lastActivityAt > INACTIVITY_TTL_MS) return 0;
    return entry.consecutiveFailures;
  } catch {
    return 0;
  }
}

/**
 * Explicit best-effort flush of all dirty in-memory entries (success counters
 * and any state a failed immediate write left behind). Exported for tests and
 * process-shutdown cleanup. Never throws.
 */
export async function flushCounters(): Promise<void> {
  try {
    const { db } = await getDb();
    // Single sync loop after the one await: no other mutation can interleave
    // between the write and the dirty-flag clear, so counters are never lost.
    for (const entry of stateMap.values()) {
      if (!entry.dirty) continue;
      if (writeEntry(db, entry)) entry.dirty = false;
    }
  } catch {
    // Fail-open: DB unavailable or broken — counters stay in memory.
  }
}

/** Test-only — wipe all state and stop the flush timer. Not stable API. */
export function __resetAdaptationStoreForTests(): void {
  try {
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    stateMap.clear();
  } catch {
    /* fail-open */
  }
}
