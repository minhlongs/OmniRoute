/**
 * Pre-dispatch skip gates for handleComboChat's executeTarget.
 * Order is locked (spec §4.1). Do not reorder.
 *
 * Extracted from combo.ts executeTarget entry through the retry loop.
 *
 * @internal — not part of the public combo.ts barrel.
 */
import {
  getRuntimeProviderProfile,
  isAccountSemaphoreFull,
  isModelLocked,
  getModelLockoutInfo,
} from "../accountFallback.ts";
import { isProviderInCooldown } from "../providerCooldownTracker.ts";
import { checkCredentialGate, logCredentialSkip } from "../credentialGate.ts";
import { errorResponse } from "../../utils/error.ts";
import { getCircuitBreaker } from "../../../src/shared/utils/circuitBreaker";
import { parseModel } from "../model.ts";
import { canAffordRequest } from "../../../src/lib/quota/quotaScheduler.ts";
import { getCachedProviderConnectionById } from "../../../src/lib/db/readCache.ts";
import { lookupPositiveCap } from "./concurrencyCaps.ts";
import { recordComboDecision } from "./decisionTrace.ts";
import {
  getExhaustedTargetSkipReason,
  resolvePersistedConnectionCooldownSkipReason,
} from "./comboPredicates.ts";
import { resolveQuotaExhaustionCutoffForTarget } from "./quotaExhaustionCutoff.ts";
import type { AttemptLoopDeps, AttemptLoopState, GateDecision } from "./attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "./types.ts";

/**
 * Cached vs fresh connection read for the persisted-cooldown gate.
 * `fresh: false` (first attempt) uses the 5s readCache. `fresh: true`
 * (every retry) goes straight to SQLite.
 *
 * Task 2 call sites pass `false` — same as combo.ts executeTarget today.
 * Retry-path `fresh: true` is Task 4 wiring, not this extract.
 */
export async function readConnectionForCooldownGate(
  connectionId: string,
  fresh: boolean
): Promise<Record<string, unknown> | null | undefined> {
  if (!fresh) return getCachedProviderConnectionById(connectionId);
  const { getProviderConnectionById } = await import("@/lib/db/providers");
  return (await getProviderConnectionById(connectionId)) as Record<string, unknown> | null;
}

export async function evaluateExecuteTargetGates(opts: {
  index: number;
  state: AttemptLoopState;
  deps: AttemptLoopDeps;
}): Promise<GateDecision> {
  const { index: i, state, deps } = opts;
  const target = state.orderedTargets[i];
  const modelStr = target.modelStr;
  const rawModel = parseModel(modelStr).model || modelStr;
  const provider = target.provider;
  const protectedPriorityTarget =
    deps.strategy === "priority" && target.fallbackOnlyOnQuotaExhaustion === true;

  const stopProtectedPriorityTarget = (message: string) => {
    state.observeFailure(false, target.executionKey);
    deps.clearStaleLKGP(deps.combo.name, target.executionKey, deps.combo.id, deps.log, "COMBO");
    return protectedPriorityTarget
      ? { ok: false as const, response: errorResponse(503, message) }
      : null;
  };

  // Lift-as-is from combo.ts executeTarget: only count a fallback when
  // this is not the first ordered target. Do not change the condition.
  const bumpFallback = () => {
    if (i > 0) state.fallbackCount++;
  };

  // 1. Strictly ban slow legacy 4.6 models on Zunef per user directive: 'lấy các model 5.5 của zunef thôi; 4.6 chậm lắm'
  const modelStrLower = String(modelStr || '').toLowerCase();
  const providerLower = String(provider || '').toLowerCase();
  const isZunefTarget =
    modelStrLower.includes('zunef') ||
    providerLower.includes('zunef') ||
    providerLower.startsWith('anthropic-compatible');

  if (isZunefTarget && /4[\.-]6/.test(modelStrLower)) {
    deps.log.warn('COMBO', '[ZUNEF-4.6-BAN] Skipping legacy 4.6 model on Zunef: ' + modelStr);
    bumpFallback();
    return { kind: 'skip', result: null };
  }

  // 2. Instant failover skip for Zunef:
  // If Zunef timed out, stalled, rate limited, or was exhausted in an earlier target of this request,
  // allow Sonnet 5.5 to try as fallback; only skip if Sonnet 5.5 has also failed!
  const isSonnetTarget = /sonnet/i.test(modelStrLower);
  if (
    isZunefTarget &&
    (state.exhaustedProviders.has('zunef') ||
      (provider && state.exhaustedProviders.has(provider)) ||
      [...state.exhaustedProviders].some((p) => String(p).toLowerCase().includes('zunef') || String(p).startsWith('anthropic-compatible')))
  ) {
    if (isSonnetTarget && !state.exhaustedProviders.has('zunef:sonnet')) {
      deps.log.info('COMBO', '[ZUNEF-FALLBACK] Allowing ' + modelStr + ' as Sonnet fallback despite Opus failure');
    } else {
      deps.log.info('COMBO', '[ZUNEF-INSTANT-FAILOVER] Skipping ' + modelStr + ' — Zunef provider already exhausted in this request');
      recordComboDecision(deps.traceInvocationId, {
        step: target.executionKey,
        target: modelStr,
        decision: 'skipped_before_dispatch',
        reason: 'request_exhaustion',
      });
      bumpFallback();
      return { kind: 'skip', result: null };
    }
  }

  const cb = getCircuitBreaker(provider);
  const cbStatus = cb.getStatus();
  if (!isZunefTarget && cbStatus.state === "OPEN") {
    state.skippedForCircuitOpen = true;
    if (
      cbStatus.retryAfterMs > 0 &&
      (state.earliestCircuitOpenRetryMs === 0 ||
        cbStatus.retryAfterMs < state.earliestCircuitOpenRetryMs)
    ) {
      state.earliestCircuitOpenRetryMs = cbStatus.retryAfterMs;
    }
    deps.log.info("COMBO", `Skipping ${modelStr} — circuit breaker OPEN for ${provider}`);
    recordComboDecision(deps.traceInvocationId, {
      step: target.executionKey,
      target: modelStr,
      decision: "skipped_before_dispatch",
      reason: "circuit_open",
    });
    bumpFallback();
    return {
      kind: "skip",
      result: stopProtectedPriorityTarget(`Provider ${provider} circuit breaker is open`),
    };
  }

  if (
    !isZunefTarget &&
    deps.resilienceSettings.providerCooldown.enabled &&
    Boolean(provider && provider !== "unknown") &&
    (isProviderInCooldown(provider, target.connectionId ?? undefined, deps.resilienceSettings) ||
      isProviderInCooldown(provider, undefined, deps.resilienceSettings))
  ) {
    deps.log.info("COMBO", `Skipping ${modelStr} — provider ${provider} in global cooldown`);
    recordComboDecision(deps.traceInvocationId, {
      step: target.executionKey,
      target: modelStr,
      decision: "skipped_before_dispatch",
      reason: "provider_cooldown",
    });
    bumpFallback();
    return {
      kind: "skip",
      result: stopProtectedPriorityTarget(`Provider ${provider} is in cooldown`),
    };
  }

  const preScreenEntry = deps.preScreenMap.get(target.executionKey);
  const profile = preScreenEntry?.profile ?? (await getRuntimeProviderProfile(provider));

  const allowRateLimitedConnection =
    Boolean(provider && provider !== "unknown") &&
    state.transientRateLimitedProviders.has(provider);
  const abortSignal = state.abortControllers.get(i)?.signal;
  const targetForAttempt = allowRateLimitedConnection
    ? {
        ...target,
        allowRateLimitedConnection: true,
        modelAbortSignal: abortSignal,
      }
    : { ...target, modelAbortSignal: abortSignal };

  if (target.connectionId && !allowRateLimitedConnection) {
    const persistedSkip = await resolvePersistedConnectionCooldownSkipReason(
      target,
      (id) => readConnectionForCooldownGate(id, false),
      allowRateLimitedConnection
    );
    if (persistedSkip) {
      try {
        const conn = await readConnectionForCooldownGate(target.connectionId, false);
        if (conn && conn.rateLimitedUntil) {
          const resetMs = new Date(String(conn.rateLimitedUntil)).getTime() - Date.now();
          if (resetMs > 0) {
            state.skippedForCircuitOpen = true;
            if (state.earliestCircuitOpenRetryMs === 0 || resetMs < state.earliestCircuitOpenRetryMs) {
              state.earliestCircuitOpenRetryMs = resetMs;
            }
          }
        }
      } catch (_) {}
      deps.log.info("COMBO", persistedSkip);
      deps.clearStaleLKGP(deps.combo.name, target.executionKey, deps.combo.id, deps.log, "COMBO");
      bumpFallback();
      return { kind: "skip", result: null };
    }
  }

  const exhaustedSkip = getExhaustedTargetSkipReason(
    target,
    state.exhaustedProviders,
    state.exhaustedConnections
  );
  if (exhaustedSkip) {
    deps.log.info("COMBO", exhaustedSkip);
    recordComboDecision(deps.traceInvocationId, {
      step: target.executionKey,
      target: modelStr,
      decision: "skipped_before_dispatch",
      reason: "request_exhaustion",
    });
    bumpFallback();
    return {
      kind: "skip",
      result: stopProtectedPriorityTarget(`Target ${modelStr} is unavailable`),
    };
  }

  if (!isZunefTarget && provider && rawModel && target.connectionId && isModelLocked(provider, target.connectionId, rawModel)) {
    const lockoutInfo = getModelLockoutInfo(provider, target.connectionId || "", rawModel);
    if (lockoutInfo && lockoutInfo.remainingMs > 0) {
      state.skippedForCircuitOpen = true;
      if (
        state.earliestCircuitOpenRetryMs === 0 ||
        lockoutInfo.remainingMs < state.earliestCircuitOpenRetryMs
      ) {
        state.earliestCircuitOpenRetryMs = lockoutInfo.remainingMs;
      }
    }
    deps.log.info("COMBO", `Skipping ${modelStr} — model locked by resilience (cooldown active)`);
    recordComboDecision(deps.traceInvocationId, {
      step: target.executionKey,
      target: modelStr,
      decision: "skipped_before_dispatch",
      reason: "model_lockout",
    });
    bumpFallback();
    return {
      kind: "skip",
      result: stopProtectedPriorityTarget(`Model ${modelStr} is locked`),
    };
  }

  if (deps.strategy !== "auto" && provider && target.connectionId) {
    const quotaCutoff = await resolveQuotaExhaustionCutoffForTarget(
      provider,
      target.connectionId,
      deps.resilienceSettings,
      deps.quotaCutoffResetWindowConfig,
      deps.combo.name,
      deps.log,
      modelStr
    );
    if (quotaCutoff.blocked) {
      deps.log.info(
        "COMBO",
        `Skipping ${modelStr} — quota exhaustion cutoff (${quotaCutoff.reason || "quota_exhausted"})`
      );
      deps.clearStaleLKGP(deps.combo.name, target.executionKey, deps.combo.id, deps.log, "COMBO");
      recordComboDecision(deps.traceInvocationId, {
        step: target.executionKey,
        target: modelStr,
        decision: "skipped_before_dispatch",
        reason: "quota_cutoff",
      });
      bumpFallback();
      state.observeFailure(true, target.executionKey);
      if (protectedPriorityTarget) {
        const protectedTargetTrust = state.targetFailureTrust.get(target.executionKey);
        if (!protectedTargetTrust?.allObservedFailuresQuota) {
          return {
            kind: "skip",
            result: {
              ok: false,
              response: errorResponse(503, `Target ${modelStr} is unavailable`),
            },
          };
        }
      }
      return { kind: "skip", result: null };
    }
  }

  // Lift-as-is: combo.ts reads the env flag inline, not via AttemptLoopDeps.
  if (process.env.OMNIROUTE_QUOTA_AWARE_ROUTING === "1" && provider && target.connectionId) {
    const quotaDecision = canAffordRequest(
      target.connectionId,
      modelStr,
      deps.body as Record<string, unknown> | null | undefined
    );
    if (!quotaDecision.affordable) {
      deps.log.info(
        "COMBO",
        `Skipping ${modelStr} — quota budget ${quotaDecision.reason} (remaining ${quotaDecision.tokensRemaining ?? 0}, cost ${quotaDecision.estimatedCost ?? 0})`
      );
      deps.clearStaleLKGP(deps.combo.name, target.executionKey, deps.combo.id, deps.log, "COMBO");
      bumpFallback();
      return { kind: "skip", result: null };
    }
  }

  const isAntiTarget = providerLower === "antigravity" || providerLower === "agy" || modelStrLower.startsWith("antigravity/") || modelStrLower.startsWith("agy/");
  if (deps.isModelAvailable && !isZunefTarget && !isAntiTarget) {
    const available = await deps.isModelAvailable(modelStr, targetForAttempt);
    if (!available) {
      deps.log.debug?.(
        "COMBO",
        `Skipping ${modelStr} — no credentials available or model excluded`
      );
      deps.clearStaleLKGP(deps.combo.name, target.executionKey, deps.combo.id, deps.log, "COMBO");
      recordComboDecision(deps.traceInvocationId, {
        step: target.executionKey,
        target: modelStr,
        decision: "skipped_before_dispatch",
        reason: "availability",
      });
      bumpFallback();
      return {
        kind: "skip",
        result: stopProtectedPriorityTarget(`Model ${modelStr} is unavailable`),
      };
    }
  }

  // Lift-as-is: combo.ts uses the same `as string | undefined` cast.
  const connectionId = target.connectionId as string | undefined;
  if (connectionId) {
    const gateResult = checkCredentialGate(connectionId, provider, modelStr);
    if (gateResult.allowed === false) {
      logCredentialSkip(deps.log, modelStr, gateResult.reason || "Credential gate blocked");
      recordComboDecision(deps.traceInvocationId, {
        step: target.executionKey,
        target: modelStr,
        decision: "skipped_before_dispatch",
        reason: "credential_gate",
      });
      bumpFallback();
      return {
        kind: "skip",
        result: stopProtectedPriorityTarget(`Credential gate blocked ${modelStr}`),
      };
    }

    const maxConcurrentCap = await lookupPositiveCap(connectionId);
    if (maxConcurrentCap && isAccountSemaphoreFull(provider, connectionId, maxConcurrentCap)) {
      deps.log.info(
        "COMBO",
        `Skipping ${modelStr} — connection ${connectionId} is at max concurrency cap (${maxConcurrentCap})`
      );
      recordComboDecision(deps.traceInvocationId, {
        step: target.executionKey,
        target: modelStr,
        decision: "skipped_before_dispatch",
        reason: "concurrency_cap",
      });
      bumpFallback();
      return {
        kind: "skip",
        result: stopProtectedPriorityTarget(`Connection capacity reached for ${modelStr}`),
      };
    }
  }

  if (
    deps.perTargetAdmission &&
    !(await deps.perTargetAdmission({
      modelStr,
      executionKey: target.executionKey,
      body: deps.body,
    }))
  ) {
    deps.log.info("COMBO", `Skipping ${modelStr} — admission lane full (#9654)`);
    recordComboDecision(deps.traceInvocationId, {
      step: target.executionKey,
      target: modelStr,
      decision: "skipped_before_dispatch",
      reason: "admission_lane",
    });
    bumpFallback();
    return { kind: "skip", result: null };
  }

  return {
    kind: "proceed",
    targetForAttempt: targetForAttempt as ResolvedComboTarget,
    profile,
    protectedPriorityTarget,
  };
}

// HMR_CRITICAL_RECOVERY_1793510227148
