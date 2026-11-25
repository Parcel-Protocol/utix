/**
 * Safe per-job cancellation and LIFO cleanup for long-running jobs.
 *
 * Complements framework-wide shutdown in `core/workers/queue.ts` with targeted,
 * authorization-enforced cancellation of individual long-running jobs:
 * - Signals the job via a dedicated `AbortSignal` (optionally linked to a
 *   parent framework signal).
 * - Waits up to `gracePeriodMs` for cooperative handlers to stop before
 *   proceeding to forced cleanup.
 * - Executes registered cleanup hooks in strict LIFO order with per-hook
 *   timeouts and failure isolation.
 * - Tracks per-hook outcomes so failed cleanups can be retried idempotently
 *   via `retryCleanup()` without re-running already-succeeded hooks.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import { WorkerCancelledError } from "@/core/workers/queue";

/** Permission required to cancel another principal's job or retry cleanup. */
export const JOB_CANCELLATION_PERMISSION: Permission = "admin:recovery";

/** Default grace period for a running handler to acknowledge cancellation. */
export const DEFAULT_GRACE_PERIOD_MS = 2_000;

/** Default timeout for each individual cleanup hook. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export type ManagedJobStatus =
  | "running"
  | "cancelling"
  | "cancelled"
  | "cleanup_failed"
  | "completed"
  | "failed";

export type CleanupStepStatus = "pending" | "succeeded" | "failed";

export type CancellationErrorCode =
  | "permission_denied"
  | "unknown_job"
  | "already_completed"
  | "already_failed"
  | "cleanup_failed"
  | "not_cleanup_failed"
  | "duplicate_job";

export type CleanupHandler = () => void | Promise<void>;

export interface CleanupStepReport {
  readonly name: string;
  status: CleanupStepStatus;
  attempts: number;
  lastError?: { code: string; message: string };
  completedAt?: string;
}

export interface ManagedJobSnapshot {
  readonly jobId: string;
  readonly operation: string;
  readonly ownerId?: string;
  readonly correlationId: string;
  readonly status: ManagedJobStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly cancelReason?: string;
  readonly cancelledBy?: string;
  readonly forced: boolean;
  readonly cleanupSteps: readonly CleanupStepReport[];
}

export interface RunCancellableJobOptions {
  readonly jobId: string;
  readonly operation: string;
  readonly ownerId?: string;
  readonly correlationId?: string;
  /** Optional parent signal (e.g. framework shutdown signal). */
  readonly parentSignal?: AbortSignal;
}

export interface CancellableJobContext {
  readonly jobId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  /**
   * Register a cleanup hook to release resources (locks, temp files, handles)
   * if this job is cancelled. Hooks run in strict LIFO order.
   */
  registerCleanup(name: string, handler: CleanupHandler): void;
}

export interface CancelJobOptions {
  readonly reason?: string;
  readonly gracePeriodMs?: number;
  readonly cleanupTimeoutMs?: number;
}

export interface RetryCleanupOptions {
  readonly cleanupTimeoutMs?: number;
}

export interface CancellationReport {
  readonly job: ManagedJobSnapshot;
  readonly idempotentReplay: boolean;
}

interface InternalCleanupStep {
  readonly name: string;
  readonly handler: CleanupHandler;
  status: CleanupStepStatus;
  attempts: number;
  lastError?: { code: string; message: string };
  completedAt?: string;
}

interface InternalManagedJob {
  readonly jobId: string;
  readonly operation: string;
  readonly ownerId?: string;
  readonly correlationId: string;
  readonly controller: AbortController;
  readonly startedAt: string;
  status: ManagedJobStatus;
  finishedAt?: string;
  cancelReason?: string;
  cancelledBy?: string;
  forced: boolean;
  readonly cleanupSteps: InternalCleanupStep[];
  readonly settledPromise: Promise<void>;
  resolveSettled: () => void;
  inFlightCancellation?: Promise<Result<CancellationReport, CancellationErrorCode>>;
}

export interface JobCancellationManager {
  /**
   * Run a long-running job under cancellation management.
   * Returns `err("duplicate_job")` if `jobId` is already registered.
   */
  runJob<T>(
    options: RunCancellableJobOptions,
    fn: (context: CancellableJobContext) => Promise<T>
  ): Promise<Result<T, CancellationErrorCode | "job_failed" | "job_cancelled">>;

  /**
   * Safely cancel a running job and execute its registered cleanup hooks in
   * LIFO order. Enforces `admin:recovery` or matching `ownerId`.
   */
  cancelJob(
    jobId: string,
    auth: AuthContext,
    options?: CancelJobOptions
  ): Promise<Result<CancellationReport, CancellationErrorCode>>;

  /**
   * Retry failed/pending cleanup hooks for a job in `cleanup_failed` state.
   * Already-succeeded hooks are skipped for idempotency.
   */
  retryCleanup(
    jobId: string,
    auth: AuthContext,
    options?: RetryCleanupOptions
  ): Promise<Result<CancellationReport, CancellationErrorCode>>;

  /** Inspect the current snapshot of a managed job. */
  getJob(jobId: string): ManagedJobSnapshot | undefined;

  /** List all managed jobs. */
  listJobs(): readonly ManagedJobSnapshot[];
}

function isAuthorized(auth: AuthContext, ownerId?: string): boolean {
  if (hasPermission(auth.role, JOB_CANCELLATION_PERMISSION)) {
    return true;
  }
  if (ownerId && auth.userId && auth.userId === ownerId) {
    return true;
  }
  return false;
}

function formatActor(auth: AuthContext): string {
  return auth.userId ? `${auth.role}:${auth.userId}` : auth.role;
}

function toErrorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: error.message || "Unknown error"
    };
  }
  return {
    code: "UnknownError",
    message: String(error)
  };
}

function snapshotOf(job: InternalManagedJob): ManagedJobSnapshot {
  return {
    jobId: job.jobId,
    operation: job.operation,
    ownerId: job.ownerId,
    correlationId: job.correlationId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancelReason: job.cancelReason,
    cancelledBy: job.cancelledBy,
    forced: job.forced,
    cleanupSteps: job.cleanupSteps.map((step) => ({
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      lastError: step.lastError ? { ...step.lastError } : undefined,
      completedAt: step.completedAt
    }))
  };
}

async function runWithTimeout(
  fn: () => void | Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new Error(`Cleanup step timed out after ${timeoutMs}ms`);
          timeoutError.name = "CleanupTimeoutError";
          reject(timeoutError);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForSettleWithGrace(
  settledPromise: Promise<void>,
  gracePeriodMs: number
): Promise<boolean> {
  if (gracePeriodMs <= 0) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      settledPromise.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), gracePeriodMs);
      })
    ]);
    return outcome === "settled";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function executeCleanupLifo(
  job: InternalManagedJob,
  cleanupTimeoutMs: number
): Promise<boolean> {
  let allSucceeded = true;

  // Run registered cleanup hooks in strict LIFO order.
  for (let i = job.cleanupSteps.length - 1; i >= 0; i--) {
    const step = job.cleanupSteps[i];
    if (step.status === "succeeded") {
      continue;
    }
    step.attempts += 1;
    try {
      await runWithTimeout(step.handler, cleanupTimeoutMs);
      step.status = "succeeded";
      step.lastError = undefined;
      step.completedAt = new Date().toISOString();
    } catch (error) {
      step.status = "failed";
      step.lastError = toErrorInfo(error);
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

export function createJobCancellationManager(): JobCancellationManager {
  const jobs = new Map<string, InternalManagedJob>();

  return {
    async runJob<T>(
      options: RunCancellableJobOptions,
      fn: (context: CancellableJobContext) => Promise<T>
    ): Promise<Result<T, CancellationErrorCode | "job_failed" | "job_cancelled">> {
      if (jobs.has(options.jobId)) {
        return err("duplicate_job");
      }

      const controller = new AbortController();
      const correlationId = options.correlationId ?? newCorrelationId();
      let resolveSettled!: () => void;
      const settledPromise = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });

      const job: InternalManagedJob = {
        jobId: options.jobId,
        operation: options.operation,
        ownerId: options.ownerId,
        correlationId,
        controller,
        startedAt: new Date().toISOString(),
        status: "running",
        forced: false,
        cleanupSteps: [],
        settledPromise,
        resolveSettled
      };

      jobs.set(options.jobId, job);

      const onParentAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(
            options.parentSignal?.reason ?? new WorkerCancelledError("Parent signal aborted")
          );
        }
      };

      if (options.parentSignal) {
        if (options.parentSignal.aborted) {
          onParentAbort();
        } else {
          options.parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }

      const context: CancellableJobContext = {
        jobId: job.jobId,
        correlationId,
        signal: controller.signal,
        registerCleanup(name: string, handler: CleanupHandler): void {
          job.cleanupSteps.push({
            name,
            handler,
            status: "pending",
            attempts: 0
          });
        }
      };

      try {
        const value = await fn(context);
        // Never mark a cancelled or cancelling job as completed.
        if (controller.signal.aborted || job.status !== "running") {
          job.resolveSettled();
          return err("job_cancelled");
        }
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        job.resolveSettled();
        return ok(value);
      } catch {
        job.resolveSettled();
        if (controller.signal.aborted || job.status === "cancelling" || job.status === "cancelled") {
          return err("job_cancelled");
        }
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        return err("job_failed");
      } finally {
        if (options.parentSignal) {
          options.parentSignal.removeEventListener("abort", onParentAbort);
        }
      }
    },

    async cancelJob(
      jobId: string,
      auth: AuthContext,
      options?: CancelJobOptions
    ): Promise<Result<CancellationReport, CancellationErrorCode>> {
      const job = jobs.get(jobId);
      if (!job) {
        return err("unknown_job");
      }

      if (!isAuthorized(auth, job.ownerId)) {
        emitTelemetry({
          op: "worker.job.cancel",
          actorType: "user",
          result: "failure",
          latencyMs: 0,
          correlationId: job.correlationId,
          payload: { jobId, reason: "permission_denied", actor: formatActor(auth) }
        });
        return err("permission_denied");
      }

      if (job.status === "completed") {
        return err("already_completed");
      }

      if (job.status === "failed") {
        return err("already_failed");
      }

      if (job.status === "cancelled") {
        return ok({
          job: snapshotOf(job),
          idempotentReplay: true
        });
      }

      if (job.status === "cleanup_failed") {
        return err("cleanup_failed");
      }

      if (job.inFlightCancellation) {
        return job.inFlightCancellation;
      }

      const startMs = Date.now();
      const reason = options?.reason ?? "operator_cancelled";
      const gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
      const cleanupTimeoutMs = options?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

      job.status = "cancelling";
      job.cancelReason = reason;
      job.cancelledBy = formatActor(auth);

      if (!job.controller.signal.aborted) {
        job.controller.abort(new WorkerCancelledError(reason));
      }

      const runCancellation = async (): Promise<
        Result<CancellationReport, CancellationErrorCode>
      > => {
        const settledInGrace = await waitForSettleWithGrace(
          job.settledPromise,
          gracePeriodMs
        );
        if (!settledInGrace) {
          job.forced = true;
        }

        const cleanupOk = await executeCleanupLifo(job, cleanupTimeoutMs);
        job.finishedAt = new Date().toISOString();

        if (!cleanupOk) {
          job.status = "cleanup_failed";
          emitTelemetry({
            op: "worker.job.cancel",
            actorType: "user",
            result: "failure",
            latencyMs: Date.now() - startMs,
            correlationId: job.correlationId,
            payload: { jobId, reason, forced: job.forced, status: job.status }
          });
          return err("cleanup_failed");
        }

        job.status = "cancelled";
        emitTelemetry({
          op: "worker.job.cancel",
          actorType: "user",
          result: "success",
          latencyMs: Date.now() - startMs,
          correlationId: job.correlationId,
          payload: { jobId, reason, forced: job.forced, status: job.status }
        });

        return ok({
          job: snapshotOf(job),
          idempotentReplay: false
        });
      };

      job.inFlightCancellation = runCancellation().finally(() => {
        job.inFlightCancellation = undefined;
      });

      return job.inFlightCancellation;
    },

    async retryCleanup(
      jobId: string,
      auth: AuthContext,
      options?: RetryCleanupOptions
    ): Promise<Result<CancellationReport, CancellationErrorCode>> {
      const job = jobs.get(jobId);
      if (!job) {
        return err("unknown_job");
      }

      if (!isAuthorized(auth, job.ownerId)) {
        emitTelemetry({
          op: "worker.job.cleanup_retry",
          actorType: "user",
          result: "failure",
          latencyMs: 0,
          correlationId: job.correlationId,
          payload: { jobId, reason: "permission_denied", actor: formatActor(auth) }
        });
        return err("permission_denied");
      }

      if (job.status !== "cleanup_failed") {
        return err("not_cleanup_failed");
      }

      const startMs = Date.now();
      const cleanupTimeoutMs = options?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
      const cleanupOk = await executeCleanupLifo(job, cleanupTimeoutMs);
      job.finishedAt = new Date().toISOString();

      if (!cleanupOk) {
        emitTelemetry({
          op: "worker.job.cleanup_retry",
          actorType: "user",
          result: "failure",
          latencyMs: Date.now() - startMs,
          correlationId: job.correlationId,
          payload: { jobId, status: job.status }
        });
        return err("cleanup_failed");
      }

      job.status = "cancelled";
      emitTelemetry({
        op: "worker.job.cleanup_retry",
        actorType: "user",
        result: "success",
        latencyMs: Date.now() - startMs,
        correlationId: job.correlationId,
        payload: { jobId, status: job.status }
      });

      return ok({
        job: snapshotOf(job),
        idempotentReplay: false
      });
    },

    getJob(jobId: string): ManagedJobSnapshot | undefined {
      const job = jobs.get(jobId);
      return job ? snapshotOf(job) : undefined;
    },

    listJobs(): readonly ManagedJobSnapshot[] {
      return Array.from(jobs.values()).map(snapshotOf);
    }
  };
}
