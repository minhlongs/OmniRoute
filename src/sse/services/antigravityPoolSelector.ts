import {
  deleteSessionAccountAffinity,
  getSessionAccountAffinity,
  touchSessionAccountAffinity,
  upsertSessionAccountAffinity,
} from "@/lib/db/sessionAccountAffinity";
import {
  getInflight,
  incrementInflight,
  decrementInflight,
} from "@omniroute/open-sse/services/combo/quotaShareInflight.ts";
import * as log from "../utils/logger";
import { formatSessionKeyForLog, getAffinityProviderAliases } from "./sessionAffinityPin";

export const ANTIGRAVITY_OVERFLOW_INFLIGHT_THRESHOLD = 2;
const CURSOR_MODULO = 1_000_000;

export interface AntigravityPoolConnection {
  id: string;
  provider?: string;
  name?: string | null;
  email?: string | null;
  priority?: number | null;
  consecutiveUseCount?: number | null;
  lastUsedAt?: string | null;
}

export interface SelectAntigravityPoolParams<T extends AntigravityPoolConnection> {
  provider: string;
  requestedModel: string | null;
  orderedConnections: T[];
  isClaudeModel: boolean;
  sessionKey?: string | null;
  sessionAffinityTtlMs: number;
  skipSideEffects: boolean;
  providerRoundRobinCursor: Map<string, number>;
  planLastUsedCommit: (connection: T) => () => Promise<void> | void;
}

export interface SelectAntigravityPoolResult<T extends AntigravityPoolConnection> {
  connection: T;
  releaseInflight?: () => void;
  commitSideEffects: () => Promise<void>;
}

function createReleaseInflight(connectionId: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    decrementInflight(connectionId);
  };
}

function formatConnectionLabel(connection: AntigravityPoolConnection): string {
  const raw = connection.name || connection.email || "-";
  const str = String(raw);
  return str.includes("@") ? str.split("@")[0].slice(0, 12) : str.slice(0, 18);
}

/**
 * Priority-tier Antigravity pool selector combining Session Affinity with In-Flight Overflow:
 * - Honors `skipSideEffects` strictly (combo pre-screen never mutates inflight, cursors, or DB).
 * - Claude targets preserve existing equal-priority round-robin (`rr:<provider>:claude`).
 * - Gemini/Orchestrator targets reuse any active Session Affinity pin (preserving 100k+ prompt
 *   cache & `_signatureNamespace`), or pick the lowest priority tier having `< 2` in-flight calls
 *   (`p=1 -> p=2 -> p=3`), falling back to global least-inflight broken strictly by lowest priority.
 */
export function selectAntigravityPoolConnection<T extends AntigravityPoolConnection>(
  params: SelectAntigravityPoolParams<T>
): SelectAntigravityPoolResult<T> {
  const {
    provider,
    requestedModel,
    orderedConnections,
    isClaudeModel,
    sessionKey,
    sessionAffinityTtlMs,
    skipSideEffects,
    providerRoundRobinCursor,
    planLastUsedCommit,
  } = params;

  const aliases = getAffinityProviderAliases(provider);
  const siblingAliases = aliases.filter((alias) => alias !== provider);

  if (isClaudeModel) {
    const cursorKey = "rr:" + provider + ":claude";
    const currentCursor = providerRoundRobinCursor.get(cursorKey) ?? 0;
    const rrConnections = [...orderedConnections].sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
    const pickedIndex = currentCursor % rrConnections.length;
    const connection = rrConnections[pickedIndex];
    let releaseInflight: (() => void) | undefined;
    if (!skipSideEffects) {
      if (rrConnections.length > 1) {
        providerRoundRobinCursor.set(cursorKey, (currentCursor + 1) % CURSOR_MODULO);
      }
      incrementInflight(connection.id);
      releaseInflight = createReleaseInflight(connection.id);
      log.info(
        "AUTH",
        `${provider} claude round-robin: picked ${connection.id?.slice(0, 8)} (${formatConnectionLabel(
          connection
        )}) [${pickedIndex + 1}/${rrConnections.length}]`
      );
    }
    const lastUsedCommit = planLastUsedCommit(connection);
    return {
      connection,
      releaseInflight,
      commitSideEffects: async () => {
        if (!skipSideEffects) {
          await lastUsedCommit();
        }
      },
    };
  }

  let stalePinFound = false;

  if (sessionKey && sessionAffinityTtlMs > 0) {
    for (const alias of aliases) {
      const pin = getSessionAccountAffinity(sessionKey, alias, sessionAffinityTtlMs);
      if (!pin) continue;
      const pinnedConnection = orderedConnections.find(
        (candidate) => candidate.id === pin.connectionId
      );
      if (pinnedConnection) {
        let releaseInflight: (() => void) | undefined;
        if (!skipSideEffects) {
          incrementInflight(pinnedConnection.id);
          releaseInflight = createReleaseInflight(pinnedConnection.id);
        }
        const lastUsedCommit = planLastUsedCommit(pinnedConnection);
        return {
          connection: pinnedConnection,
          releaseInflight,
          commitSideEffects: async () => {
            if (!skipSideEffects) {
              const now = Date.now();
              touchSessionAccountAffinity(sessionKey, alias, now, sessionAffinityTtlMs);
              if (alias !== provider) {
                upsertSessionAccountAffinity(
                  sessionKey,
                  provider,
                  pinnedConnection.id,
                  now,
                  sessionAffinityTtlMs
                );
              }
              log.info(
                "AUTH",
                `session_key=${formatSessionKeyForLog(
                  sessionKey
                )} -> connection ${pinnedConnection.id.slice(
                  0,
                  8
                )} (affinity, inflight=${getInflight(pinnedConnection.id)})`
              );
              await lastUsedCommit();
            }
          },
        };
      }
      stalePinFound = true;
    }
  }

  const inflightMap = new Map<string, number>();
  for (const c of orderedConnections) {
    inflightMap.set(c.id, getInflight(c.id));
  }

  const priorities = [...new Set(orderedConnections.map((c) => c.priority ?? 999))].sort(
    (a, b) => a - b
  );
  let selectedCandidates: T[] = [];
  let selectedPriority: number | null = null;
  let overflowed = false;

  for (const p of priorities) {
    const tierUnderCap = orderedConnections.filter(
      (c) =>
        (c.priority ?? 999) === p &&
        (inflightMap.get(c.id) ?? 0) < ANTIGRAVITY_OVERFLOW_INFLIGHT_THRESHOLD
    );
    if (tierUnderCap.length > 0) {
      const minTierInflight = Math.min(...tierUnderCap.map((c) => inflightMap.get(c.id) ?? 0));
      selectedCandidates = tierUnderCap
        .filter((c) => (inflightMap.get(c.id) ?? 0) === minTierInflight)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      selectedPriority = p;
      overflowed = priorities.length > 0 && p > priorities[0];
      break;
    }
  }

  if (selectedCandidates.length === 0) {
    const globalMinInflight = Math.min(
      ...orderedConnections.map((c) => inflightMap.get(c.id) ?? 0)
    );
    const minInflightCandidates = orderedConnections.filter(
      (c) => (inflightMap.get(c.id) ?? 0) === globalMinInflight
    );
    const minFallbackPriority = Math.min(
      ...minInflightCandidates.map((c) => c.priority ?? 999)
    );
    selectedCandidates = minInflightCandidates
      .filter((c) => (c.priority ?? 999) === minFallbackPriority)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    overflowed = true;
  }

  const cursorKey =
    "rr:" +
    provider +
    ":" +
    (selectedPriority !== null ? `p${selectedPriority}` : "overflow") +
    ":" +
    (requestedModel || "non-claude");
  const currentCursor = providerRoundRobinCursor.get(cursorKey) ?? 0;
  const pickedIndex = currentCursor % selectedCandidates.length;
  const connection = selectedCandidates[pickedIndex];

  const inflightBefore = inflightMap.get(connection.id) ?? 0;
  let releaseInflight: (() => void) | undefined;
  if (!skipSideEffects) {
    // Only advance cursor when >= 2 candidates tied; single-candidate waves must not reset cursor.
    if (selectedCandidates.length > 1) {
      providerRoundRobinCursor.set(cursorKey, (currentCursor + 1) % CURSOR_MODULO);
    }
    incrementInflight(connection.id);
    releaseInflight = createReleaseInflight(connection.id);
    log.info(
      "AUTH",
      `${provider} priority-tier${overflowed ? "-overflow" : ""} (priority=${
        connection.priority ?? 999
      }, inflight=${inflightBefore}->${inflightBefore + 1}): picked ${connection.id?.slice(
        0,
        8
      )} (${formatConnectionLabel(connection)}) [${pickedIndex + 1}/${selectedCandidates.length}]`
    );
  }
  const lastUsedCommit = planLastUsedCommit(connection);

  return {
    connection,
    releaseInflight,
    commitSideEffects: async () => {
      if (!skipSideEffects) {
        if (sessionKey && sessionAffinityTtlMs > 0) {
          if (stalePinFound) {
            log.info(
              "AUTH",
              `affinity cleared for session_key=${formatSessionKeyForLog(
                sessionKey
              )} provider=${provider}`
            );
          }
          for (const sibling of siblingAliases) {
            deleteSessionAccountAffinity(sessionKey, sibling);
          }
          upsertSessionAccountAffinity(
            sessionKey,
            provider,
            connection.id,
            Date.now(),
            sessionAffinityTtlMs
          );
          log.info(
            "AUTH",
            `new affinity created for session_key=${formatSessionKeyForLog(
              sessionKey
            )} -> connection ${connection.id.slice(0, 8)}`
          );
        }
        await lastUsedCommit();
      }
    },
  };
}
