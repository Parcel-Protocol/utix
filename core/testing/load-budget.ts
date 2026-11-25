/**
 * Worst-case load harness and resource budgets (#392).
 *
 * Drives an operation N times at a fixed concurrency, records per-call
 * latency, errors, retries and heap growth, then checks the run against a
 * declared budget. An operation "fails" when it throws or returns a
 * `Result` with `ok: false`; thrown errors may be retried, Result errors are
 * expected outcomes and are never retried.
 */

import { err, ok, type Result } from "@/core/result/result";

export interface LoadProfile {
  readonly iterations: number;
  readonly concurrency: number;
}

export interface RetryPolicy {
  /** Total attempts per call, including the first. */
  readonly maxAttempts: number;
  readonly isRetryable?: (error: unknown) => boolean;
}

export interface ResourceBudget {
  readonly maxP95Ms: number;
  /** Fraction 0..1 of calls allowed to end in failure. */
  readonly maxErrorRate: number;
  /** Optional: heap growth is noisy under GC, so budgets should be generous. */
  readonly maxHeapGrowthBytes?: number;
  /** Optional cap on total retries across the run. */
  readonly maxRetries?: number;
}

export interface LoadReport {
  readonly iterations: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly retries: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly heapGrowthBytes: number;
}

function isResultErr(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export async function runLoad(
  operation: (index: number) => unknown,
  profile: LoadProfile,
  retry: RetryPolicy = { maxAttempts: 1 }
): Promise<LoadReport> {
  if (profile.iterations < 1 || profile.concurrency < 1 || retry.maxAttempts < 1) {
    throw new RangeError("iterations, concurrency and maxAttempts must be >= 1");
  }

  const latencies: number[] = new Array(profile.iterations);
  let errors = 0;
  let retries = 0;
  let next = 0;
  const heapBefore = process.memoryUsage().heapUsed;

  const worker = async (): Promise<void> => {
    while (next < profile.iterations) {
      const index = next++;
      const start = performance.now();
      let end = start;
      let failed = false;
      for (let attempt = 1; ; attempt++) {
        try {
          // Only await real promises: awaiting a sync result would let other
          // workers run first and bill their time to this call's latency.
          const out = operation(index);
          const value = out instanceof Promise ? await out : out;
          end = performance.now();
          failed = isResultErr(value);
          break;
        } catch (error) {
          const canRetry = attempt < retry.maxAttempts && (retry.isRetryable?.(error) ?? true);
          if (!canRetry) {
            end = performance.now();
            failed = true;
            break;
          }
          retries++;
        }
      }
      if (failed) errors++;
      latencies[index] = end - start;
    }
  };

  await Promise.all(Array.from({ length: Math.min(profile.concurrency, profile.iterations) }, worker));

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    iterations: profile.iterations,
    errors,
    errorRate: errors / profile.iterations,
    retries,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    heapGrowthBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore)
  };
}

/** Returns the report when it fits the budget, else every violated limit. */
export function checkBudget(
  report: LoadReport,
  budget: ResourceBudget
): Result<LoadReport, "budget_exceeded", string[]> {
  const violations: string[] = [];
  if (report.p95Ms > budget.maxP95Ms) {
    violations.push(`p95 ${report.p95Ms.toFixed(2)}ms > ${budget.maxP95Ms}ms`);
  }
  if (report.errorRate > budget.maxErrorRate) {
    violations.push(`error rate ${report.errorRate.toFixed(3)} > ${budget.maxErrorRate}`);
  }
  if (budget.maxHeapGrowthBytes !== undefined && report.heapGrowthBytes > budget.maxHeapGrowthBytes) {
    violations.push(`heap growth ${report.heapGrowthBytes}B > ${budget.maxHeapGrowthBytes}B`);
  }
  if (budget.maxRetries !== undefined && report.retries > budget.maxRetries) {
    violations.push(`retries ${report.retries} > ${budget.maxRetries}`);
  }
  return violations.length === 0 ? ok(report) : err("budget_exceeded", violations);
}
