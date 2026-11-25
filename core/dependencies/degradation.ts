/**
 * Dependency degradation matrix and fallback behavior (#340).
 *
 * Utix talks to a handful of things it does not control: Horizon, Soroban RPC,
 * the Freighter extension, Friendbot, remote `stellar.toml` / federation hosts
 * and browser storage. This module states, in one table, how each of them can
 * fail, how hard the app retries, what it falls back to and what the user is
 * told. `callWithFallback` is the single code path that applies the table.
 *
 * Behavior per call:
 *
 * 1. If the dependency is `down` (a run of failures reached the threshold) and
 *    the recovery window has not elapsed, the primary call is skipped entirely:
 *    the circuit is open, so a dead upstream is not hammered.
 * 2. Otherwise the primary is tried up to `retry.maxAttempts` times with
 *    exponential backoff. `invalid_response` failures are not retried: the
 *    upstream answered, and asking again returns the same bad payload.
 * 3. Success records recovery (the dependency is `healthy` again). Exhausted
 *    failure records the failure mode, then the fallback runs if the matrix
 *    allows one and the caller supplied it.
 * 4. Without a usable fallback the call fails with a stable error code plus
 *    the matrix's user-facing message, which never contains upstream detail.
 *
 * Operators can pin a dependency's level (e.g. force `down` during a provider
 * incident, or back to `healthy` after it) with `override`, which requires
 * `admin:health`. Overrides expire on `clearOverride` or `until`, so a
 * forgotten override recovers by itself.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";

export const DEPENDENCY_IDS = [
  "horizon",
  "soroban_rpc",
  "freighter",
  "friendbot",
  "stellar_toml",
  "browser_storage"
] as const;
export type DependencyId = (typeof DEPENDENCY_IDS)[number];

export type FailureMode = "timeout" | "rate_limited" | "unavailable" | "invalid_response";

export type DegradationLevel = "healthy" | "degraded" | "down";

/**
 * What the app does once the primary call is exhausted:
 * - `cached_read`  — serve the last good response the caller kept;
 * - `read_only`    — keep viewing, disable anything that signs or submits;
 * - `in_memory`    — keep working for this tab only, nothing is persisted;
 * - `feature_off`  — hide the dependent action and explain why;
 * - `none`         — fail with a clear message; there is no safe substitute.
 */
export type FallbackStrategy = "cached_read" | "read_only" | "in_memory" | "feature_off" | "none";

export interface DependencyMatrixEntry {
  readonly id: DependencyId;
  readonly description: string;
  /** Failure modes this dependency is expected to produce. */
  readonly failureModes: readonly FailureMode[];
  readonly retry: { readonly maxAttempts: number; readonly baseDelayMs: number };
  readonly fallback: FallbackStrategy;
  /** True when no tool can do its core job without this dependency. */
  readonly critical: boolean;
  /** Safe, user-facing explanation shown when the fallback is in effect. */
  readonly userMessage: string;
}

const MATRIX: Record<DependencyId, DependencyMatrixEntry> = {
  horizon: {
    id: "horizon",
    description: "Horizon REST API: accounts, transactions, ledgers, order books",
    failureModes: ["timeout", "rate_limited", "unavailable", "invalid_response"],
    retry: { maxAttempts: 3, baseDelayMs: 250 },
    fallback: "cached_read",
    critical: true,
    userMessage: "Live network data is temporarily unavailable. Showing the last data loaded, which may be out of date."
  },
  soroban_rpc: {
    id: "soroban_rpc",
    description: "Soroban RPC: contract simulation, events, ledger entries",
    failureModes: ["timeout", "rate_limited", "unavailable", "invalid_response"],
    retry: { maxAttempts: 3, baseDelayMs: 250 },
    fallback: "read_only",
    critical: true,
    userMessage: "Contract simulation is temporarily unavailable. You can still inspect and decode, but not simulate."
  },
  freighter: {
    id: "freighter",
    description: "Freighter browser extension: public key and signing",
    failureModes: ["timeout", "unavailable"],
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    fallback: "read_only",
    critical: false,
    userMessage: "Wallet connection is unavailable. Tools keep working in read-only mode; paste an address instead."
  },
  friendbot: {
    id: "friendbot",
    description: "Friendbot testnet faucet",
    failureModes: ["timeout", "rate_limited", "unavailable"],
    retry: { maxAttempts: 2, baseDelayMs: 1_000 },
    fallback: "feature_off",
    critical: false,
    userMessage: "The testnet faucet is not responding. Try again later or fund the account from another testnet account."
  },
  stellar_toml: {
    id: "stellar_toml",
    description: "Remote stellar.toml and federation servers on third-party domains",
    failureModes: ["timeout", "unavailable", "invalid_response"],
    retry: { maxAttempts: 2, baseDelayMs: 500 },
    fallback: "none",
    critical: false,
    userMessage: "The domain's stellar.toml could not be loaded. The issuer's server may be down or misconfigured."
  },
  browser_storage: {
    id: "browser_storage",
    description: "localStorage for preferences, history and notifications",
    failureModes: ["unavailable"],
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    fallback: "in_memory",
    critical: false,
    userMessage: "Browser storage is unavailable, so settings will not be saved after this tab closes."
  }
};

export const DEGRADATION_MATRIX: Readonly<Record<DependencyId, DependencyMatrixEntry>> = Object.freeze(MATRIX);

export interface DependencyState {
  readonly id: DependencyId;
  readonly level: DegradationLevel;
  readonly consecutiveFailures: number;
  readonly lastFailureMode: FailureMode | null;
  /** Epoch ms of the most recent failure, or null. */
  readonly lastFailureAt: number | null;
  /** Operator override in effect, if any. */
  readonly override: { readonly level: DegradationLevel; readonly until: number | null; readonly by: string } | null;
}

export type DegradationErrorCode =
  | "dependency_unavailable"
  | "fallback_failed"
  | "unknown_dependency"
  | "override_forbidden"
  | "invalid_override";

export interface FallbackFailure {
  readonly dependency: DependencyId;
  readonly failureMode: FailureMode | null;
  readonly strategy: FallbackStrategy;
  readonly userMessage: string;
}

export interface CallOutcome<T> {
  readonly value: T;
  /** `fallback` when the caller's substitute produced the value. */
  readonly source: "primary" | "fallback";
  readonly attempts: number;
  /** Present when `source` is `fallback`: what to tell the user. */
  readonly userMessage?: string;
}

export interface CallOptions<T> {
  /** Substitute used when the matrix strategy is not `none`. */
  readonly fallback?: () => T | Promise<T>;
}

export interface DegradationTrackerOptions {
  /** Consecutive failures after which a dependency is `down`. Default 3. */
  readonly failureThreshold?: number;
  /** How long a `down` dependency is skipped before one probe call. Default 30 s. */
  readonly recoveryWindowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override the matrix, e.g. in tests. Missing ids use `DEGRADATION_MATRIX`. */
  readonly matrix?: Partial<Record<DependencyId, DependencyMatrixEntry>>;
}

export interface DegradationTracker {
  state(id: DependencyId): DependencyState;
  states(): DependencyState[];
  entry(id: DependencyId): DependencyMatrixEntry;
  recordFailure(id: DependencyId, mode: FailureMode): DependencyState;
  recordSuccess(id: DependencyId): DependencyState;
  override(
    id: DependencyId,
    level: DegradationLevel,
    auth: AuthContext,
    until?: number | null
  ): Result<DependencyState, DegradationErrorCode>;
  clearOverride(id: DependencyId, auth: AuthContext): Result<DependencyState, DegradationErrorCode>;
  callWithFallback<T>(
    id: DependencyId,
    primary: () => T | Promise<T>,
    options?: CallOptions<T>
  ): Promise<Result<CallOutcome<T>, DegradationErrorCode, FallbackFailure>>;
}

/** Maps a thrown value to a failure mode without reading its message. */
export function classifyFailure(error: unknown): FailureMode {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
    if (name === "SyntaxError") return "invalid_response";
    const raw =
      (error as { status?: unknown }).status ??
      (error as { response?: { status?: unknown } }).response?.status;
    if (raw === 429) return "rate_limited";
    if (typeof raw === "number" && raw >= 400 && raw < 500) return "invalid_response";
  }
  return "unavailable";
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_RECOVERY_MS = 30_000;
const OVERRIDE_PERMISSION = "admin:health" as const;

interface MutableState {
  consecutiveFailures: number;
  lastFailureMode: FailureMode | null;
  lastFailureAt: number | null;
  override: { level: DegradationLevel; until: number | null; by: string } | null;
}

function isDependencyId(value: string): value is DependencyId {
  return (DEPENDENCY_IDS as readonly string[]).includes(value);
}

export function createDegradationTracker(options: DegradationTrackerOptions = {}): DegradationTracker {
  const threshold = Math.max(1, options.failureThreshold ?? DEFAULT_THRESHOLD);
  const recoveryWindowMs = Math.max(0, options.recoveryWindowMs ?? DEFAULT_RECOVERY_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const states = new Map<DependencyId, MutableState>();

  function entry(id: DependencyId): DependencyMatrixEntry {
    return options.matrix?.[id] ?? DEGRADATION_MATRIX[id];
  }

  function raw(id: DependencyId): MutableState {
    let current = states.get(id);
    if (!current) {
      current = { consecutiveFailures: 0, lastFailureMode: null, lastFailureAt: null, override: null };
      states.set(id, current);
    }
    if (current.override && current.override.until !== null && now() >= current.override.until) {
      current.override = null;
    }
    return current;
  }

  function computedLevel(current: MutableState): DegradationLevel {
    if (current.consecutiveFailures >= threshold) return "down";
    if (current.consecutiveFailures > 0) return "degraded";
    return "healthy";
  }

  function snapshot(id: DependencyId): DependencyState {
    const current = raw(id);
    return {
      id,
      level: current.override?.level ?? computedLevel(current),
      consecutiveFailures: current.consecutiveFailures,
      lastFailureMode: current.lastFailureMode,
      lastFailureAt: current.lastFailureAt,
      override: current.override ? { ...current.override } : null
    };
  }

  function recordFailure(id: DependencyId, mode: FailureMode): DependencyState {
    const current = raw(id);
    current.consecutiveFailures += 1;
    current.lastFailureMode = mode;
    current.lastFailureAt = now();
    return snapshot(id);
  }

  function recordSuccess(id: DependencyId): DependencyState {
    const current = raw(id);
    current.consecutiveFailures = 0;
    current.lastFailureMode = null;
    return snapshot(id);
  }

  /**
   * `closed`: call normally. `half_open`: the dependency is down but its
   * recovery window has elapsed, so one probe attempt is allowed. `open`: skip
   * the primary.
   */
  function circuit(id: DependencyId): "closed" | "half_open" | "open" {
    const state = snapshot(id);
    if (state.override) return state.override.level === "down" ? "open" : "closed";
    if (state.level !== "down") return "closed";
    if (state.lastFailureAt === null || now() - state.lastFailureAt >= recoveryWindowMs) {
      return "half_open";
    }
    return "open";
  }

  return {
    entry,
    state: snapshot,
    states: () => DEPENDENCY_IDS.map((id) => snapshot(id)),
    recordFailure,
    recordSuccess,

    override(id, level, auth, until = null) {
      if (!hasPermission(auth.role, OVERRIDE_PERMISSION)) return err("override_forbidden");
      if (!isDependencyId(id)) return err("unknown_dependency");
      if (until !== null && (!Number.isFinite(until) || until <= now())) return err("invalid_override");
      raw(id).override = { level, until, by: auth.userId ?? auth.role };
      return ok(snapshot(id));
    },

    clearOverride(id, auth) {
      if (!hasPermission(auth.role, OVERRIDE_PERMISSION)) return err("override_forbidden");
      if (!isDependencyId(id)) return err("unknown_dependency");
      raw(id).override = null;
      return ok(snapshot(id));
    },

    async callWithFallback<T>(
      id: DependencyId,
      primary: () => T | Promise<T>,
      callOptions: CallOptions<T> = {}
    ): Promise<Result<CallOutcome<T>, DegradationErrorCode, FallbackFailure>> {
      if (!isDependencyId(id)) return err("unknown_dependency");
      const matrixEntry = entry(id);
      let attempts = 0;
      let lastMode: FailureMode | null = snapshot(id).lastFailureMode;

      const mode = circuit(id);
      if (mode !== "open") {
        const maxAttempts = mode === "half_open" ? 1 : Math.max(1, matrixEntry.retry.maxAttempts);
        while (attempts < maxAttempts) {
          attempts += 1;
          try {
            const value = await primary();
            recordSuccess(id);
            return ok({ value, source: "primary", attempts });
          } catch (error) {
            lastMode = classifyFailure(error);
            if (lastMode === "invalid_response" || attempts >= maxAttempts) break;
            await sleep(matrixEntry.retry.baseDelayMs * 2 ** (attempts - 1));
          }
        }
        recordFailure(id, lastMode ?? "unavailable");
      }

      const failure: FallbackFailure = {
        dependency: id,
        failureMode: lastMode,
        strategy: matrixEntry.fallback,
        userMessage: matrixEntry.userMessage
      };
      if (matrixEntry.fallback === "none" || !callOptions.fallback) {
        return err("dependency_unavailable", failure);
      }
      try {
        const value = await callOptions.fallback();
        return ok({ value, source: "fallback", attempts, userMessage: matrixEntry.userMessage });
      } catch {
        return err("fallback_failed", failure);
      }
    }
  };
}
