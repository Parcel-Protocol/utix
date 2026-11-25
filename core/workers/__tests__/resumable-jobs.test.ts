/**
 * Resumable jobs and dead-letter recovery (#334).
 *
 * Normal path: a handler saves checkpoints and a later attempt resumes from
 * them. Failure path: non-serializable checkpoints, recovery of jobs that are
 * not dead letters, unregistered handlers. Retry path: automatic retries,
 * manual `retryJob`, idempotent recovery. Authorization: only `admin:recovery`
 * may recover a dead letter.
 */

import { describe, expect, it } from "vitest";
import { createWorkerFramework, type WorkerContext } from "@/core/workers/queue";

const LATER = () => Date.now() + 60 * 60 * 1_000;
const MAINTAINER = { role: "maintainer" as const, userId: "ops-1" };

/** Processes `items` one by one, failing once at `failAt` per framework run. */
function batchHandler(items: number[], processed: number[], failAt: () => number | null) {
  return (_params: Record<string, unknown>, context: WorkerContext) => {
    const start = typeof context.checkpoint === "number" ? context.checkpoint : 0;
    for (let index = start; index < items.length; index += 1) {
      if (failAt() === index) throw new Error(`failed at ${index}`);
      processed.push(items[index]);
      context.saveCheckpoint(index + 1);
    }
  };
}

describe("resumable jobs", () => {
  it("resumes a retried attempt from the last saved checkpoint", () => {
    const worker = createWorkerFramework({ retryDelayMs: 1 });
    const processed: number[] = [];
    let failAt: number | null = 2;
    worker.register("batch.import", batchHandler([10, 20, 30, 40], processed, () => failAt));

    const job = worker.enqueue({ operation: "batch.import", maxAttempts: 3 });
    worker.drainDueJobs();
    expect(worker.getById(job.id)?.status).toBe("retrying");
    expect(worker.getById(job.id)?.checkpoint).toBe(2);

    failAt = null;
    worker.drainDueJobs(LATER());
    expect(worker.getById(job.id)?.status).toBe("succeeded");
    // Items 10 and 20 were not processed twice.
    expect(processed).toEqual([10, 20, 30, 40]);
  });

  it("starts a fresh job with no checkpoint", () => {
    const worker = createWorkerFramework();
    let seen: unknown = "unset";
    worker.register("probe", (_p, context) => {
      seen = context.checkpoint;
    });
    worker.enqueue({ operation: "probe" });
    worker.drainDueJobs();
    expect(seen).toBeUndefined();
  });

  it("stores a deep copy, so later mutation by the handler has no effect", () => {
    const worker = createWorkerFramework();
    worker.register("copy", (_p, context) => {
      const progress = { cursor: "a", done: [1] };
      context.saveCheckpoint(progress);
      progress.cursor = "mutated";
      progress.done.push(2);
    });
    const job = worker.enqueue({ operation: "copy" });
    worker.drainDueJobs();
    expect(worker.getById(job.id)?.checkpoint).toEqual({ cursor: "a", done: [1] });
  });

  it("fails the attempt when a checkpoint is not JSON-serializable", () => {
    const worker = createWorkerFramework();
    worker.register("bad.checkpoint", (_p, context) => {
      context.saveCheckpoint(() => "not data");
    });
    const job = worker.enqueue({ operation: "bad.checkpoint", maxAttempts: 1 });
    worker.drainDueJobs();
    const stored = worker.getById(job.id);
    expect(stored?.status).toBe("dead_lettered");
    expect(stored?.lastError?.code).toBe("TypeError");
    expect(stored?.checkpoint).toBeUndefined();
  });

  it("keeps the checkpoint across a manual retry", () => {
    const worker = createWorkerFramework({ retryDelayMs: 1 });
    const processed: number[] = [];
    let failAt: number | null = 1;
    worker.register("batch.manual", batchHandler([1, 2, 3], processed, () => failAt));

    const job = worker.enqueue({ operation: "batch.manual", maxAttempts: 3 });
    worker.drainDueJobs();
    const retried = worker.retryJob(job.id);
    expect(retried.ok).toBe(true);
    expect(worker.getById(job.id)?.checkpoint).toBe(1);

    failAt = null;
    worker.drainDueJobs();
    expect(processed).toEqual([1, 2, 3]);
  });
});

describe("dead-letter recovery", () => {
  it("recovers a dead letter as a new job that resumes from its checkpoint", () => {
    const worker = createWorkerFramework();
    const processed: number[] = [];
    let failAt: number | null = 2;
    worker.register("batch.export", batchHandler([1, 2, 3, 4], processed, () => failAt));

    const job = worker.enqueue({
      operation: "batch.export",
      params: { region: "eu" },
      dedupeKey: "export:eu",
      maxAttempts: 1
    });
    worker.drainDueJobs();
    expect(worker.getById(job.id)?.status).toBe("dead_lettered");

    failAt = null;
    const recovered = worker.recoverDeadLetter(job.id, MAINTAINER);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const replacement = recovered.value;

    expect(replacement.id).not.toBe(job.id);
    expect(replacement.status).toBe("queued");
    expect(replacement.attempts).toBe(0);
    expect(replacement.maxAttempts).toBe(1);
    expect(replacement.params).toEqual({ region: "eu" });
    expect(replacement.dedupeKey).toBe("export:eu");
    expect(replacement.correlationId).toBe(job.correlationId);
    expect(replacement.recoveredFrom).toBe(job.id);
    expect(replacement.checkpoint).toBe(2);

    // The dead letter is kept, unchanged apart from the link, for audit.
    const original = worker.getById(job.id);
    expect(original?.status).toBe("dead_lettered");
    expect(original?.lastError?.message).toBe("failed at 2");
    expect(original?.recoveredBy).toBe(replacement.id);

    worker.drainDueJobs();
    expect(worker.getById(replacement.id)?.status).toBe("succeeded");
    expect(processed).toEqual([1, 2, 3, 4]);
  });

  it("can restart from scratch when resume is false", () => {
    const worker = createWorkerFramework();
    const processed: number[] = [];
    let failAt: number | null = 1;
    worker.register("batch.fresh", batchHandler([5, 6], processed, () => failAt));

    const job = worker.enqueue({ operation: "batch.fresh", maxAttempts: 1 });
    worker.drainDueJobs();

    failAt = null;
    const recovered = worker.recoverDeadLetter(job.id, MAINTAINER, { resume: false });
    expect(recovered.ok && recovered.value.checkpoint).toBeUndefined();
    worker.drainDueJobs();
    expect(processed).toEqual([5, 5, 6]);
  });

  it("is idempotent: recovering twice returns the same replacement", () => {
    const worker = createWorkerFramework();
    worker.register("flaky", () => {
      throw new Error("down");
    });
    const job = worker.enqueue({ operation: "flaky", maxAttempts: 1 });
    worker.drainDueJobs();

    const first = worker.recoverDeadLetter(job.id, MAINTAINER);
    const second = worker.recoverDeadLetter(job.id, MAINTAINER);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(worker.inspect().length).toBe(2);
  });

  it("lets a replacement that dead-letters again be recovered in turn", () => {
    const worker = createWorkerFramework();
    worker.register("always.fails", () => {
      throw new Error("still down");
    });
    const job = worker.enqueue({ operation: "always.fails", maxAttempts: 1 });
    worker.drainDueJobs();
    const first = worker.recoverDeadLetter(job.id, MAINTAINER);
    if (!first.ok) throw new Error("expected recovery");
    worker.drainDueJobs();
    expect(worker.getById(first.value.id)?.status).toBe("dead_lettered");

    const second = worker.recoverDeadLetter(first.value.id, MAINTAINER);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.recoveredFrom).toBe(first.value.id);
  });

  it("requires the admin:recovery permission", () => {
    const worker = createWorkerFramework();
    worker.register("flaky", () => {
      throw new Error("down");
    });
    const job = worker.enqueue({ operation: "flaky", maxAttempts: 1 });
    worker.drainDueJobs();

    expect(worker.recoverDeadLetter(job.id, { role: "viewer" })).toEqual({
      ok: false,
      code: "unauthorized"
    });
    expect(worker.recoverDeadLetter(job.id, { role: "service" })).toEqual({
      ok: false,
      code: "unauthorized"
    });
    expect(worker.getById(job.id)?.recoveredBy).toBeUndefined();
    expect(worker.inspect().length).toBe(1);
  });

  it("refuses jobs that are not dead letters, and unknown ids", () => {
    const worker = createWorkerFramework();
    worker.register("ok", () => undefined);
    const queued = worker.enqueue({ operation: "ok" });
    expect(worker.recoverDeadLetter(queued.id, MAINTAINER)).toEqual({
      ok: false,
      code: "not_dead_lettered"
    });

    worker.drainDueJobs();
    expect(worker.getById(queued.id)?.status).toBe("succeeded");
    expect(worker.recoverDeadLetter(queued.id, MAINTAINER)).toEqual({
      ok: false,
      code: "not_dead_lettered"
    });
    expect(worker.recoverDeadLetter("missing", MAINTAINER)).toEqual({
      ok: false,
      code: "unknown_job"
    });
  });

  it("refuses to recover while the handler is still unregistered", () => {
    const worker = createWorkerFramework();
    const job = worker.enqueue({ operation: "not.yet.deployed" });
    worker.drainDueJobs();
    expect(worker.getById(job.id)?.lastError?.code).toBe("unregistered");

    expect(worker.recoverDeadLetter(job.id, MAINTAINER)).toEqual({
      ok: false,
      code: "unregistered"
    });

    worker.register("not.yet.deployed", () => undefined);
    const recovered = worker.recoverDeadLetter(job.id, MAINTAINER);
    expect(recovered.ok).toBe(true);
    worker.drainDueJobs();
    if (recovered.ok) {
      expect(worker.getById(recovered.value.id)?.status).toBe("succeeded");
    }
  });
});
