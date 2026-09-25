/**
 * Background worker framework for delayed and retryable work.
 *
 * Jobs run outside request handlers with a defined payload format, a retry
 * budget and a dead-letter store, so a task that keeps failing preserves enough
 * context to debug instead of being silently dropped.
 *
 * The queue is deliberately in-memory and dependency-free. Work in this app is
 * initiated client-side, so `drainDueJobs()` is called when a path wants its
 * due work executed; a job is never run twice for the same payload, and
 * reprocessing a job by id is idempotent (a finished job is left untouched).
 */

import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "retrying"
  | "dead_lettered";

export interface JobPayload {
  readonly id: string;
  /** Stable, dot-separated operation the handler registered under. */
  readonly operation: string;
  readonly params: Record<string, unknown>;
  /**
   * When set, enqueueing another job with the same key is a no-op for as long
   * as the original job is still queued — the idempotent reprocess.
   */
  readonly dedupeKey?: string;
  readonly maxAttempts: number;
  attempts: number;
  status: JobStatus;
  readonly enqueuedAt: string;
  /** When `status` is `retrying`, the earliest time the job may run again. */
  nextAttemptAt?: string;
  /** Serializable failure context — code plus message, never secrets. */
  lastError?: { code: string; message: string };
  readonly correlationId: string;
}

export interface JobInput {
  operation: string;
  params?: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts?: number;
  correlationId?: string;
  /** When set, the first run is scheduled this many ms after enqueueing. */
  delayMs?: number;
}

export interface WorkerContext {
  correlationId: string;
  attempt: number;
}

export type JobHandler = (
  params: Record<string, unknown>,
  context: WorkerContext
) => void | Promise<void>;

export interface RetryPolicy {
  /** Base delay in ms; the nth retry waits `retryDelayMs * 2^(n - 1)`. */
  retryDelayMs: number;
  /** Total attempts including the first, after which a job is dead-lettered. */
  maxAttempts: number;
}

export interface RunSummary {
  ran: number;
  succeeded: number;
  failed: number;
  retried: number;
  deadLettered: number;
}

const DEFAULT_POLICY: RetryPolicy = { retryDelayMs: 250, maxAttempts: 3 };

export interface WorkerFramework {
  register(operation: string, handler: JobHandler, policy?: Partial<RetryPolicy>): void;
  enqueue(input: JobInput): JobPayload;
  /** Executes every due job once and returns the lifecycle summary. */
  drainDueJobs(now?: number): RunSummary;
  /** Idempotent reprocess of a single job by id. */
  processJob(id: string): RunSummary;
  /** Resets a job to a fresh queued state so it can be retried. */
  retryJob(id: string): JobPayload | undefined;
  deadLetter(id: string): JobPayload | undefined;
  inspect(status?: JobStatus): JobPayload[];
  getById(id: string): JobPayload | undefined;
  /** Test seam: clears the queue and all registrations. */
  reset(): void;
}

/** Exponential backoff: `delay * 2^(attempt - 1)`, capped to avoid overflow. */
export function retryBackoff(baseDelayMs: number, attempt: number): number {
  const factor = 2 ** Math.min(attempt - 1, 30);
  return baseDelayMs * factor;
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

function findingDedupe(jobs: Map<string, JobPayload>, key: string): JobPayload | undefined {
  for (const job of jobs.values()) {
    if (job.dedupeKey === key && (job.status === "queued" || job.status === "retrying")) {
      return job;
    }
  }
  return undefined;
}

export function createWorkerFramework(policy: Partial<RetryPolicy> = {}): WorkerFramework {
  const mergedPolicy: RetryPolicy = { ...DEFAULT_POLICY, ...policy };
  const registrations = new Map<string, { handler: JobHandler; retryDelayMs: number; maxAttempts: number }>();
  const jobs = new Map<string, JobPayload>();

  function isDue(job: JobPayload, now: number): boolean {
    if (job.status !== "queued" && job.status !== "retrying") return false;
    if (job.nextAttemptAt === undefined) return true;
    return Date.parse(job.nextAttemptAt) <= now;
  }

  function runJob(job: JobPayload): void {
    job.attempts += 1;
    const registration = registrations.get(job.operation);

    if (!registration) {
      job.lastError = {
        code: "unregistered",
        message: `No handler registered for ${job.operation}`
      };
      job.status = "dead_lettered";
      emitTelemetry({
        op: "worker.exhausted",
        actorType: "worker",
        result: "failure",
        correlationId: job.correlationId,
        errorCode: "unregistered"
      });
      return;
    }

    try {
      job.status = "running";
      registration.handler(job.params, {
        correlationId: job.correlationId,
        attempt: job.attempts
      });
      job.status = "succeeded";
      job.lastError = undefined;
      emitTelemetry({
        op: "worker.run",
        actorType: "worker",
        result: "success",
        correlationId: job.correlationId,
        payload: { operation: job.operation, attempt: job.attempts }
      });
    } catch (error) {
      const code = errorCodeOf(error);
      job.lastError = {
        code,
        message: error instanceof Error ? error.message : "unknown failure"
      };

      // The job's own budget wins; the registration only supplies the default.
      if (job.attempts >= job.maxAttempts) {
        job.status = "dead_lettered";
        emitTelemetry({
          op: "worker.exhausted",
          actorType: "worker",
          result: "failure",
          correlationId: job.correlationId,
          errorCode: code,
          payload: { operation: job.operation, attempts: job.attempts }
        });
      } else {
        job.status = "retrying";
        job.nextAttemptAt = new Date(
          Date.now() + retryBackoff(registration.retryDelayMs, job.attempts)
        ).toISOString();
        emitTelemetry({
          op: "worker.retry",
          actorType: "worker",
          result: "failure",
          correlationId: job.correlationId,
          errorCode: code,
          payload: { operation: job.operation, attempt: job.attempts }
        });
      }
    }
  }

  function bumpSummary(summary: RunSummary, job: JobPayload): void {
    if (job.status === "succeeded") summary.succeeded += 1;
    else if (job.status === "retrying") summary.retried += 1;
    else if (job.status === "dead_lettered") summary.deadLettered += 1;
    else summary.failed += 1;
  }

  return {
    register(operation, handler, custom = {}): void {
      if (registrations.has(operation)) {
        throw new Error(`[workers] handler already registered for ${operation}`);
      }
      registrations.set(operation, {
        handler,
        retryDelayMs: custom.retryDelayMs ?? mergedPolicy.retryDelayMs,
        maxAttempts: custom.maxAttempts ?? mergedPolicy.maxAttempts
      });
    },

    enqueue(input: JobInput): JobPayload {
      if (input.dedupeKey) {
        const existing = findingDedupe(jobs, input.dedupeKey);
        if (existing) return existing;
      }

      const job: JobPayload = {
        id: newCorrelationId(),
        operation: input.operation,
        params: input.params ?? {},
        dedupeKey: input.dedupeKey,
        maxAttempts: input.maxAttempts ?? mergedPolicy.maxAttempts,
        attempts: 0,
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        nextAttemptAt:
          input.delayMs && input.delayMs > 0
            ? new Date(Date.now() + input.delayMs).toISOString()
            : undefined,
        correlationId: input.correlationId ?? newCorrelationId()
      };
      jobs.set(job.id, job);
      return job;
    },

    drainDueJobs(now = Date.now()): RunSummary {
      const summary: RunSummary = { ran: 0, succeeded: 0, failed: 0, retried: 0, deadLettered: 0 };
      const due = [...jobs.values()].filter((job) => isDue(job, now));

      for (const job of due) {
        summary.ran += 1;
        runJob(job);
        bumpSummary(summary, job);
      }
      return summary;
    },

    processJob(id: string): RunSummary {
      const summary: RunSummary = { ran: 0, succeeded: 0, failed: 0, retried: 0, deadLettered: 0 };
      const job = jobs.get(id);
      if (!job) return summary;
      // Idempotent reprocessing: a finished job is left untouched.
      if (job.status === "succeeded" || job.status === "dead_lettered") return summary;

      summary.ran += 1;
      runJob(job);
      bumpSummary(summary, job);
      return summary;
    },

    retryJob(id: string): JobPayload | undefined {
      const job = jobs.get(id);
      if (!job || job.status === "dead_lettered") return undefined;
      job.status = "queued";
      job.nextAttemptAt = undefined;
      job.attempts = 0;
      return job;
    },

    deadLetter(id: string): JobPayload | undefined {
      const job = jobs.get(id);
      if (!job) return undefined;
      job.status = "dead_lettered";
      return job;
    },

    inspect(status?: JobStatus): JobPayload[] {
      const all = [...jobs.values()];
      return status ? all.filter((job) => job.status === status) : all;
    },

    getById(id: string): JobPayload | undefined {
      return jobs.get(id);
    },

    reset(): void {
      jobs.clear();
      registrations.clear();
    }
  };
}