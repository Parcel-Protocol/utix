/**
 * Synthetic monitoring for high-value user journeys (#368)
 *
 * The #269 probe covers one journey (the operation browser). This catalogue
 * adds the other journeys users depend on most, each mirroring the exact
 * Horizon calls of a real tool, so an upstream contract break is seen on a
 * schedule rather than in a bug report:
 *
 * | Journey              | Tool                  | Steps after `horizon.root`                         |
 * | -------------------- | --------------------- | -------------------------------------------------- |
 * | `operation-history`  | `operation-browser`   | the #269 journey, unchanged                        |
 * | `account-balances`   | `balance-viewer`      | `operations.discover` → `account.load`             |
 * | `transaction-lookup` | `transaction-lookup`  | `transactions.discover` → `transaction.load`       |
 * | `fee-stats`          | `fee-stats`           | `fee_stats.load`                                   |
 *
 * Every journey opens with `horizon.root`, so a probe pointed at the wrong
 * network fails as `network_mismatch` instead of passing on the wrong data.
 * Fixtures are discovered from the newest ledger activity, never hard-coded,
 * so a testnet reset cannot break a journey. Retries, timeouts and skipped
 * steps come from the shared engine in `probe.ts`.
 *
 * Authorization: `admin:health`, checked before any request, as in #269.
 *
 * Complexity per journey: at most 3 steps × `maxAttempts` requests; O(n) time
 * over the records a step validates (at most one page or one balance list).
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { amountToStroops } from "@/core/format/amount";
import type { HealthStatus } from "@/core/health/types";
import { HORIZON_URLS } from "@/core/network/config";
import type { StellarNetwork } from "@/core/network/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import {
  createProbe,
  embeddedRecords,
  firstFailure,
  journeyStatus,
  type Probe,
  type ProbeStepResult,
  type SyntheticErrorCode
} from "./probe";
import {
  runSyntheticMonitor,
  SYNTHETIC_DEFAULTS,
  validateActiveAccount,
  validateHorizonRoot,
  type SyntheticMonitorOptions,
  type SyntheticStepName
} from "./synthetic";

export const JOURNEY_IDS = ["operation-history", "account-balances", "transaction-lookup", "fee-stats"] as const;
export type JourneyId = (typeof JOURNEY_IDS)[number];

export type JourneyStepName =
  | SyntheticStepName
  | "account.load"
  | "transactions.discover"
  | "transaction.load"
  | "fee_stats.load";

export interface JourneyDefinition {
  readonly id: JourneyId;
  readonly title: string;
  /** The feature slug whose Horizon contract the journey proves. */
  readonly tool: string;
  /**
   * A critical journey's sustained failure makes the whole workflow
   * `unhealthy` (#410); a non-critical one only degrades it.
   */
  readonly critical: boolean;
}

export const JOURNEYS: Readonly<Record<JourneyId, JourneyDefinition>> = {
  "operation-history": { id: "operation-history", title: "Browse an account's operation history", tool: "operation-browser", critical: true },
  "account-balances": { id: "account-balances", title: "View an account's balances", tool: "balance-viewer", critical: true },
  "transaction-lookup": { id: "transaction-lookup", title: "Look up a transaction by hash", tool: "transaction-lookup", critical: true },
  "fee-stats": { id: "fee-stats", title: "Read current network fees", tool: "fee-stats", critical: false }
};

export function isJourneyId(value: unknown): value is JourneyId {
  return typeof value === "string" && (JOURNEY_IDS as readonly string[]).includes(value);
}

export interface JourneyReport {
  readonly journey: JourneyId;
  readonly network: StellarNetwork;
  readonly status: HealthStatus;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly ProbeStepResult<JourneyStepName>[];
  readonly ingestLagLedgers?: number;
}

export type JourneyOptions = SyntheticMonitorOptions;
export type JourneyErrorCode = "synthetic_unauthorized" | "unknown_journey";

const HASH = /^[0-9a-f]{64}$/;
const UINT = /^\d+$/;
const FEE_PERCENTILES = ["min", "p10", "p20", "p30", "p40", "p50", "p60", "p70", "p80", "p90", "p95", "p99", "max"] as const;

/** `GET /accounts/{id}`: the account Horizon returns is the one asked for, with exact balances. */
export function validateAccount(body: unknown, accountId: string): Result<{ balances: number }, SyntheticErrorCode> {
  const account = (body ?? {}) as Record<string, unknown>;
  if (account.id !== accountId || typeof account.sequence !== "string" || !UINT.test(account.sequence)) {
    return err("malformed_payload");
  }
  const balances = account.balances;
  if (!Array.isArray(balances) || balances.length === 0) return err("malformed_payload");
  let native = false;
  for (const line of balances as Record<string, unknown>[]) {
    // Balances must be exact seven-decimal amounts the tool can parse without floats.
    if (line === null || typeof line !== "object" || typeof line.balance !== "string") return err("malformed_payload");
    const stroops = amountToStroops(line.balance);
    if (stroops === null || stroops < 0n || typeof line.asset_type !== "string") return err("malformed_payload");
    if (line.asset_type === "native") native = true;
  }
  // Every account holds XLM for its base reserve; no native line means a broken projection.
  return native ? ok({ balances: balances.length }) : err("malformed_payload");
}

/** `GET /transactions?order=desc&limit=1`: the newest transaction's hash. */
export function validateLatestTransaction(body: unknown): Result<string, SyntheticErrorCode> {
  const page = embeddedRecords(body);
  if (!page) return err("malformed_payload");
  if (page.length === 0) return err("no_activity");
  const hash = page[0].hash;
  return typeof hash === "string" && HASH.test(hash) ? ok(hash) : err("malformed_payload");
}

/** `GET /transactions/{hash}`: the same transaction comes back, with a ledger and an outcome. */
export function validateTransaction(body: unknown, hash: string): Result<{ ledger: number }, SyntheticErrorCode> {
  const tx = (body ?? {}) as Record<string, unknown>;
  if (tx.hash !== hash || typeof tx.successful !== "boolean" || !Number.isSafeInteger(tx.ledger) || (tx.ledger as number) < 1) {
    return err("malformed_payload");
  }
  return ok({ ledger: tx.ledger as number });
}

/**
 * `GET /fee_stats`: integer-string fees (never floats), percentiles that never
 * decrease from `min` to `max`, and a capacity usage between 0 and 1.
 */
export function validateFeeStats(body: unknown): Result<{ p50: bigint }, SyntheticErrorCode> {
  const stats = (body ?? {}) as Record<string, unknown>;
  const { last_ledger, last_ledger_base_fee, ledger_capacity_usage, fee_charged } = stats;
  if (typeof last_ledger !== "string" || !UINT.test(last_ledger)) return err("malformed_payload");
  if (typeof last_ledger_base_fee !== "string" || !UINT.test(last_ledger_base_fee)) return err("malformed_payload");
  const usage = typeof ledger_capacity_usage === "string" ? Number(ledger_capacity_usage) : Number.NaN;
  if (!(usage >= 0 && usage <= 1)) return err("malformed_payload");
  if (fee_charged === null || typeof fee_charged !== "object") return err("malformed_payload");

  let previous = -1n;
  let p50 = 0n;
  for (const key of FEE_PERCENTILES) {
    const raw = (fee_charged as Record<string, unknown>)[key];
    if (typeof raw !== "string" || !UINT.test(raw)) return err("malformed_payload");
    const value = BigInt(raw);
    if (value < previous) return err("malformed_payload");
    previous = value;
    if (key === "p50") p50 = value;
  }
  return ok({ p50 });
}

type Steps = (probe: Probe<JourneyStepName>, network: StellarNetwork) => Promise<{ ingestLag?: number }>;

const JOURNEY_STEPS: Record<Exclude<JourneyId, "operation-history">, Steps> = {
  async "account-balances"(probe, network) {
    const root = await probe.step("horizon.root", "", {}, (body) => validateHorizonRoot(body, network));
    const accountId = root && (await probe.step("operations.discover", "operations", { order: "desc", limit: "1" }, validateActiveAccount));
    if (!root) probe.skip("operations.discover");
    if (accountId) {
      await probe.step("account.load", `accounts/${encodeURIComponent(accountId)}`, {}, (body) => validateAccount(body, accountId));
    } else {
      probe.skip("account.load");
    }
    return { ingestLag: root?.ingestLag };
  },

  async "transaction-lookup"(probe, network) {
    const root = await probe.step("horizon.root", "", {}, (body) => validateHorizonRoot(body, network));
    const hash = root && (await probe.step("transactions.discover", "transactions", { order: "desc", limit: "1" }, validateLatestTransaction));
    if (!root) probe.skip("transactions.discover");
    if (hash) {
      await probe.step("transaction.load", `transactions/${hash}`, {}, (body) => validateTransaction(body, hash));
    } else {
      probe.skip("transaction.load");
    }
    return { ingestLag: root?.ingestLag };
  },

  async "fee-stats"(probe, network) {
    const root = await probe.step("horizon.root", "", {}, (body) => validateHorizonRoot(body, network));
    if (root) await probe.step("fee_stats.load", "fee_stats", {}, validateFeeStats);
    else probe.skip("fee_stats.load");
    return { ingestLag: root?.ingestLag };
  }
};

/**
 * Runs one journey against live Horizon. `operation-history` delegates to
 * `runSyntheticMonitor`, so the #269 journey and its telemetry are unchanged.
 * Every run emits one `synthetic.journey` event carrying `payload.journey`.
 */
export async function runJourney(
  auth: AuthContext,
  journey: JourneyId,
  options: JourneyOptions
): Promise<Result<JourneyReport, JourneyErrorCode>> {
  if (!isJourneyId(journey)) return err("unknown_journey");

  if (journey === "operation-history") {
    const outcome = await runSyntheticMonitor(auth, options);
    return outcome.ok ? ok({ journey, ...outcome.value }) : outcome;
  }

  const correlationId = newCorrelationId();
  if (!hasPermission(auth.role, "admin:health")) {
    emitTelemetry({
      op: "synthetic.journey",
      actorType: "system",
      result: "failure",
      correlationId,
      errorCode: "synthetic_unauthorized",
      payload: { journey, network: options.network, role: auth.role }
    });
    return err("synthetic_unauthorized");
  }

  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => Date.now());
  const probe = createProbe<JourneyStepName>({
    baseUrl: options.horizonUrl ?? HORIZON_URLS[options.network],
    fetch: options.fetch,
    sleep: options.sleep,
    now,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs
  });

  const startedAt = now();
  const { ingestLag } = await JOURNEY_STEPS[journey](probe, options.network);
  const durationMs = now() - startedAt;
  const steps = [...probe.steps];
  const failed = firstFailure(steps);
  const status = journeyStatus(
    steps,
    durationMs,
    options.latencyBudgetMs ?? SYNTHETIC_DEFAULTS.latencyBudgetMs,
    (ingestLag ?? 0) > (options.maxIngestLagLedgers ?? SYNTHETIC_DEFAULTS.maxIngestLagLedgers)
  );

  emitTelemetry({
    op: "synthetic.journey",
    actorType: "system",
    result: failed ? "failure" : "success",
    latencyMs: durationMs,
    correlationId,
    errorCode: failed?.errorCode,
    payload: {
      journey,
      network: options.network,
      status,
      steps: steps.map(({ step: name, ok: passed, attempts }) => ({ name, passed, attempts }))
    }
  });

  return ok({
    journey,
    network: options.network,
    status,
    correlationId,
    startedAt: new Date(clock()).toISOString(),
    durationMs,
    steps,
    ...(ingestLag === undefined ? {} : { ingestLagLedgers: ingestLag })
  });
}
