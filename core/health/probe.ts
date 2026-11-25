/**
 * Shared HTTP probe engine for synthetic monitoring (#269, #368, #410).
 *
 * Extracted from `synthetic.ts` so every synthetic journey retries, times out,
 * validates and reports in exactly the same way:
 *
 * - transient failures (HTTP 429, 5xx, transport errors, timeouts) are retried
 *   with exponential backoff, honouring `Retry-After`, and no single wait
 *   exceeds `maxDelayMs`;
 * - contract failures (malformed body, wrong network, other 4xx) are not
 *   retried: retrying cannot fix them;
 * - a step that never ran because an earlier step failed is recorded as
 *   `skipped` (attempts 0), so a report always lists the whole journey, but a
 *   skipped step is never counted as the failure.
 *
 * Complexity: O(steps × maxAttempts) requests; O(1) bookkeeping per attempt.
 */

import type { HealthStatus } from "@/core/health/types";
import { err, ok, type Result } from "@/core/result/result";

export type SyntheticErrorCode =
  | "rate_limited"
  | "server_error"
  | "transport"
  | "timeout"
  | "http_status"
  | "malformed_payload"
  | "network_mismatch"
  | "no_activity"
  | "pagination_broken"
  /** The step did not run because an earlier step in its journey failed. */
  | "skipped";

export interface ProbeStepResult<Name extends string = string> {
  readonly step: Name;
  readonly ok: boolean;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly errorCode?: SyntheticErrorCode;
  /** Present and true only on a step that never ran. */
  readonly skipped?: true;
}

export interface ProbeSettings {
  /** Per-request timeout. */
  readonly timeoutMs: number;
  /** Attempts per step, including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Ceiling for any single backoff, including a server's `Retry-After`. */
  readonly maxDelayMs: number;
}

export const PROBE_DEFAULTS: ProbeSettings = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000
};

export interface ProbeOptions extends Partial<ProbeSettings> {
  /** Base URL every step path is resolved against. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface Attempt {
  readonly result: Result<unknown, SyntheticErrorCode>;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/**
 * `Retry-After` is delay-seconds or an HTTP-date (RFC 9110 §10.2.3). All three
 * HTTP-date forms (IMF-fixdate, RFC 850, asctime) open with a day name, which
 * keeps `Date.parse` from reading a value like `-1` as a year. The result is
 * always a finite, non-negative number of milliseconds, or `undefined`.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // A long digit run overflows to Infinity; cap it so callers always get a finite delay (#359).
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1_000, Number.MAX_SAFE_INTEGER);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * The wait before retry number `attempt` (1-based: the wait after the first
 * failed attempt is `retryDelayMs(1, …)`). Exponential from `baseDelayMs`,
 * lengthened by `Retry-After`, never above `maxDelayMs`, never negative.
 */
export function retryDelayMs(
  attempt: number,
  settings: Pick<ProbeSettings, "baseDelayMs" | "maxDelayMs">,
  retryAfterMs?: number
): number {
  const backoff = settings.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const wanted = Math.max(backoff, retryAfterMs ?? 0);
  return Math.max(0, Math.min(Number.isNaN(wanted) ? 0 : wanted, settings.maxDelayMs));
}

/** `_embedded.records` when it is a list of objects, else null. */
export function embeddedRecords(body: unknown): Record<string, unknown>[] | null {
  const list = (body as { _embedded?: { records?: unknown } } | null)?._embedded?.records;
  return Array.isArray(list) && list.every((item) => item !== null && typeof item === "object")
    ? (list as Record<string, unknown>[])
    : null;
}

export interface Probe<Name extends string> {
  /** Fetches with retries, validates, and records the step. Null means the journey stops. */
  step<T>(
    name: Name,
    path: string,
    query: Record<string, string>,
    validate: (body: unknown) => Result<T, SyntheticErrorCode>
  ): Promise<T | null>;
  /** Records a step that did not run because an earlier one failed. */
  skip(name: Name): void;
  readonly steps: readonly ProbeStepResult<Name>[];
}

export function createProbe<Name extends string>(options: ProbeOptions): Probe<Name> {
  // `??` per field, so an explicit `undefined` keeps the default instead of
  // turning the timeout into an immediate abort.
  const settings: ProbeSettings = {
    timeoutMs: options.timeoutMs ?? PROBE_DEFAULTS.timeoutMs,
    maxAttempts: options.maxAttempts ?? PROBE_DEFAULTS.maxAttempts,
    baseDelayMs: options.baseDelayMs ?? PROBE_DEFAULTS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? PROBE_DEFAULTS.maxDelayMs
  };
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const base = `${options.baseUrl.replace(/\/+$/, "")}/`;
  const steps: ProbeStepResult<Name>[] = [];

  async function attempt(url: string): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (response.status === 429) {
        return {
          result: err("rate_limited"),
          retryable: true,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now())
        };
      }
      if (response.status >= 500) return { result: err("server_error"), retryable: true };
      if (!response.ok) return { result: err("http_status"), retryable: false };
      try {
        return { result: ok(await response.json()), retryable: false };
      } catch {
        return { result: err("malformed_payload"), retryable: false };
      }
    } catch {
      return { result: err(controller.signal.aborted ? "timeout" : "transport"), retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function step<T>(
    name: Name,
    path: string,
    query: Record<string, string>,
    validate: (body: unknown) => Result<T, SyntheticErrorCode>
  ): Promise<T | null> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const started = now();
    let attempts = 0;
    let outcome: Attempt;
    for (;;) {
      attempts += 1;
      outcome = await attempt(url.toString());
      if (!outcome.retryable || attempts >= settings.maxAttempts) break;
      await sleep(retryDelayMs(attempts, settings, outcome.retryAfterMs));
    }

    const validated = outcome.result.ok ? validate(outcome.result.value) : outcome.result;
    steps.push({
      step: name,
      ok: validated.ok,
      attempts,
      latencyMs: now() - started,
      ...(validated.ok ? {} : { errorCode: validated.code })
    });
    return validated.ok ? validated.value : null;
  }

  function skip(name: Name): void {
    steps.push({ step: name, ok: false, attempts: 0, latencyMs: 0, errorCode: "skipped", skipped: true });
  }

  return { step, skip, steps };
}

/** The first step that ran and failed; skipped steps are never the cause. */
export function firstFailure<Name extends string>(
  steps: readonly ProbeStepResult<Name>[]
): ProbeStepResult<Name> | undefined {
  return steps.find((result) => !result.ok && !result.skipped);
}

/**
 * `unhealthy` when a step failed; `degraded` when every step passed but one
 * needed a retry, the run exceeded its budget, or `extraDegraded` holds;
 * otherwise `healthy`.
 */
export function journeyStatus(
  steps: readonly ProbeStepResult[],
  durationMs: number,
  latencyBudgetMs: number,
  extraDegraded = false
): HealthStatus {
  if (firstFailure(steps)) return "unhealthy";
  return steps.some((result) => result.attempts > 1) || durationMs > latencyBudgetMs || extraDegraded
    ? "degraded"
    : "healthy";
}
