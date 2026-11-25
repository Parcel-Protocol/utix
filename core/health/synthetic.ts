
/**
 * Synthetic monitoring for the critical end-to-end journey (#269)
 *
 * The critical journey (tests/e2e/critical-journey.spec.ts) is the operation
 * browser: load an account's operation history newest-first, then follow the
 * last paging token to the next older page. The e2e spec proves the UI against
 * mocked Horizon; this probe proves the same Horizon contract against the live
 * network on a schedule, so an upstream break is seen before a user reports it.
 *
 * Steps, each against the configured Horizon:
 *   1. `horizon.root`             `GET /` — reachable, right network passphrase,
 *                                 ingestion lag (`core_latest_ledger` −
 *                                 `history_latest_ledger`) within tolerance.
 *   2. `operations.discover`      `GET /operations?order=desc&limit=1` — finds a
 *                                 currently active account, so the probe needs
 *                                 no fixture that a testnet reset would delete.
 *   3. `account.operations`       `GET /accounts/{id}/operations?order=desc&limit=20`
 *                                 — the journey's first page.
 *   4. `account.operations.older` the same with `cursor=<last paging_token>`,
 *                                 only when page one was full — the "Load more" step.
 *
 * The retry/timeout engine lives in `probe.ts` (shared with the journey
 * catalogue, #368). Transient failures (HTTP 429, 5xx, transport errors, timeouts) are retried
 * with exponential backoff, honouring `Retry-After`. Contract failures (wrong
 * passphrase, malformed body, broken pagination) are not retried: retrying
 * cannot fix them. Running the probe is an operator action gated on
 * `admin:health`.
 *
 * Complexity: O(steps × maxAttempts) requests; O(page size) time and space per
 * step to validate one page.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import type { HealthStatus } from "@/core/health/types";
import { HORIZON_URLS, NETWORK_PASSPHRASES } from "@/core/network/config";
import type { StellarNetwork } from "@/core/network/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import {
  createProbe,
  embeddedRecords,
  firstFailure,
  journeyStatus,
  type ProbeStepResult,
  type SyntheticErrorCode
} from "./probe";

// Kept importable from here: the engine moved to `probe.ts` (#368), the contract did not.
export { parseRetryAfter, type SyntheticErrorCode } from "./probe";

export type SyntheticStepName =
  | "horizon.root"
  | "operations.discover"
  | "account.operations"
  | "account.operations.older";

export type SyntheticStepResult = ProbeStepResult<SyntheticStepName>;

export interface SyntheticReport {
  readonly network: StellarNetwork;
  readonly status: HealthStatus;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly SyntheticStepResult[];
  /** `core_latest_ledger − history_latest_ledger` from `GET /`. */
  readonly ingestLagLedgers?: number;
}

export interface SyntheticMonitorOptions {
  readonly network: StellarNetwork;
  /** Defaults to the configured Horizon for `network`. */
  readonly horizonUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** Attempts per step, including the first. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  /** Ceiling for any single backoff, including a server's `Retry-After`. */
  readonly maxDelayMs?: number;
  /** A run slower than this is `degraded`. */
  readonly latencyBudgetMs?: number;
  /** Ingestion lag above this is `degraded`. */
  readonly maxIngestLagLedgers?: number;
  /** Injectable clock for deterministic tests of `startedAt`/`durationMs`. */
  readonly clock?: () => number;
}

/** Mirrors the operation browser's page size, so page two is exercised exactly as users reach it. */
export const SYNTHETIC_PAGE_SIZE = 20;

export const SYNTHETIC_DEFAULTS = {
  latencyBudgetMs: 5_000,
  maxIngestLagLedgers: 5
} as const;

export const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const PAGING_TOKEN = /^\d+$/;

/**
 * Paging tokens must be numeric, unique and strictly descending, and every one
 * must sit below `cursor` when one was sent. O(n) over the page.
 */
function isDescendingPage(page: Record<string, unknown>[], cursor?: string): boolean {
  let previous = cursor === undefined ? undefined : BigInt(cursor);
  for (const record of page) {
    const token = record.paging_token;
    if (typeof token !== "string" || !PAGING_TOKEN.test(token)) return false;
    const value = BigInt(token);
    if (previous !== undefined && value >= previous) return false;
    previous = value;
  }
  return true;
}

/** Validates Horizon's root document and returns the ingestion lag. Shared with the journey catalogue (#368). */
export function validateHorizonRoot(
  body: unknown,
  network: StellarNetwork
): Result<{ ingestLag: number }, SyntheticErrorCode> {
  const { network_passphrase, core_latest_ledger, history_latest_ledger } = (body ?? {}) as Record<string, unknown>;
  if (typeof network_passphrase !== "string" || !Number.isSafeInteger(core_latest_ledger) || !Number.isSafeInteger(history_latest_ledger)) {
    return err("malformed_payload");
  }
  if (network_passphrase !== NETWORK_PASSPHRASES[network]) return err("network_mismatch");
  return ok({ ingestLag: (core_latest_ledger as number) - (history_latest_ledger as number) });
}

/** Picks the source account of the newest operation, so no fixture is needed. Shared with #368. */
export function validateActiveAccount(body: unknown): Result<string, SyntheticErrorCode> {
  const page = embeddedRecords(body);
  if (!page) return err("malformed_payload");
  if (page.length === 0) return err("no_activity");
  const source = page[0].source_account;
  return typeof source === "string" && PUBLIC_KEY.test(source) ? ok(source) : err("malformed_payload");
}

export async function runSyntheticMonitor(
  auth: AuthContext,
  options: SyntheticMonitorOptions
): Promise<Result<SyntheticReport, "synthetic_unauthorized">> {
  const correlationId = newCorrelationId();
  if (!hasPermission(auth.role, "admin:health")) {
    emitTelemetry({
      op: "synthetic.journey",
      actorType: "system",
      result: "failure",
      correlationId,
      errorCode: "synthetic_unauthorized",
      payload: { network: options.network, role: auth.role }
    });
    return err("synthetic_unauthorized");
  }

  const latencyBudgetMs = options.latencyBudgetMs ?? SYNTHETIC_DEFAULTS.latencyBudgetMs;
  const maxIngestLagLedgers = options.maxIngestLagLedgers ?? SYNTHETIC_DEFAULTS.maxIngestLagLedgers;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => Date.now());
  const probe = createProbe<SyntheticStepName>({
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

  const root = await probe.step("horizon.root", "", {}, (body) => validateHorizonRoot(body, options.network));

  const accountId = root && (await probe.step("operations.discover", "operations", { order: "desc", limit: "1" }, validateActiveAccount));
  if (!root) probe.skip("operations.discover");

  const operationsPath = accountId ? `accounts/${encodeURIComponent(accountId)}/operations` : "";
  const query = { order: "desc", limit: String(SYNTHETIC_PAGE_SIZE) };
  const firstPage =
    accountId &&
    (await probe.step("account.operations", operationsPath, query, (body) => {
      const page = embeddedRecords(body);
      if (!page) return err("malformed_payload");
      // The account was just discovered from its own operation, so an empty page is broken.
      if (page.length === 0 || !isDescendingPage(page)) return err("pagination_broken");
      return ok(page);
    }));
  if (!accountId) probe.skip("account.operations");

  // A short first page means there is no older page: the UI hides "Load more",
  // so the step is not part of this journey and is not listed (#269).
  if (firstPage && firstPage.length === SYNTHETIC_PAGE_SIZE) {
    const cursor = firstPage[firstPage.length - 1].paging_token as string;
    await probe.step("account.operations.older", operationsPath, { ...query, cursor }, (body) => {
      const page = embeddedRecords(body);
      if (!page) return err("malformed_payload");
      return isDescendingPage(page, cursor) ? ok(page) : err("pagination_broken");
    });
  }

  const steps = probe.steps;
  const durationMs = now() - startedAt;
  const failed = firstFailure(steps);
  const ingestLagLedgers = root?.ingestLag;
  const status = journeyStatus(steps, durationMs, latencyBudgetMs, (ingestLagLedgers ?? 0) > maxIngestLagLedgers);

  emitTelemetry({
    op: "synthetic.journey",
    actorType: "system",
    result: failed ? "failure" : "success",
    latencyMs: durationMs,
    correlationId,
    errorCode: failed?.errorCode,
    payload: { journey: "operation-history", network: options.network, status, steps: steps.map(({ step: name, ok: passed, attempts }) => ({ name, passed, attempts })) }
  });

  return ok({
    network: options.network,
    status,
    correlationId,
    startedAt: new Date(clock()).toISOString(),
    durationMs,
    steps: [...steps],
    ...(ingestLagLedgers === undefined ? {} : { ingestLagLedgers })
  });
}
