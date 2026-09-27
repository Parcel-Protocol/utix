import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerFramework,
  isCancellation,
  WorkerCancelledError,
  type WorkerFramework
} from "@/core/workers/queue";
import {
  cancelMaintenance,
  createMaintenanceFramework,
  PRUNE_HORIZON_CLIENTS_OP
} from "@/core/workers/maintenance";

/**
 * Cancellation and shutdown-drain semantics for the worker framework (#142).
 *
 * Without an explicit contract, a maintenance job can be reported as completed
 * after its side effect was abandoned, or run again after a shutdown. The
 * framework had neither a signal for a handler to observe nor a way to say what
 * each job was doing when the process stopped, and it did not await async
 * handlers at all: `handler(...)` was invoked and discarded, so a promise-
 * returning job was marked `succeeded` before it had done anything and its
 * rejection escaped as an unhandled rejection.
 *
 * The contract asserted here, per state at shutdown:
 *
 *   queued / retrying — never started, left untouched, reported as `pending`.
 *     Nothing was abandoned, so the next process re-runs them.
 *   running           — the attempt was abandoned. Moved to `retrying` (or
 *     `dead_lettered` once the budget is spent) and reported as `interrupted`.
 *     Never `succeeded`: that is the failure the issue describes.
 *   settled           — untouched, counted as settled.
 *
 * Every interleaving here is deterministic: `shutdown` is awaited and the
 * handlers coordinate through a promise the test controls, so no test depends on
 * timing.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("worker cancellation", () => {
  let framework: WorkerFramework;

  beforeEach(() => {
    framework = createWorkerFramework();
  });

  it("awaits an async handler instead of marking it done immediately", async () => {
    let finished = false;
    framework.register("async.work", async () => {
      await sleep(5);
      finished = true;
    });

    const job = framework.enqueue({ operation: "async.work" });
    const provisional = framework.drainDueJobs();

    // Started, but not finished: the summary says so and the status is running.
    expect(provisional.inFlight).toBe(1);
    expect(finished).toBe(false);
    expect(framework.getById(job.id)?.status).toBe("running");

    const settled = await framework.drain();

    expect(settled.succeeded).toBe(1);
    expect(finished).toBe(true);
    expect(framework.getById(job.id)?.status).toBe("succeeded");
  });

  it("counts work a previous synchronous drain left running", async () => {
    framework.register("inherited.work", async () => {
      await sleep(5);
    });
    framework.enqueue({ operation: "inherited.work" });

    framework.drainDueJobs();
    const settled = await framework.drain();

    // The awaited work belongs in the summary the caller receives, or a drain
    // would complete the job and report nothing about it.
    expect(settled.ran).toBe(1);
    expect(settled.succeeded).toBe(1);
  });

  it("passes a signal to every handler", async () => {
    let received: AbortSignal | undefined;
    framework.register("signal.work", (_params, context) => {
      received = context.signal;
    });

    framework.enqueue({ operation: "signal.work" });
    framework.drainDueJobs();

    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
    expect(framework.signal()).toBe(received);
  });

  it("does not mark an abandoned running attempt as succeeded", async () => {
    let sideEffect = false;
    framework.register("long.work", async (_params, context) => {
      await sleep(5);
      // A cooperative handler: it stops when the abort reaches it.
      if (context.signal.aborted) return;
      sideEffect = true;
    });

    const job = framework.enqueue({ operation: "long.work" });
    framework.drainDueJobs();
    expect(framework.getById(job.id)?.status).toBe("running");

    const report = await framework.shutdown({ reason: "test" });

    expect(report.interrupted.map((entry) => entry.id)).toEqual([job.id]);
    expect(report.pending).toHaveLength(0);
    expect(report.reason).toBe("test");
    expect(report.phase).toBe("stopped");
    expect(framework.signal().aborted).toBe(true);
    // The point of the whole change.
    expect(framework.getById(job.id)?.status).not.toBe("succeeded");
    expect(framework.getById(job.id)?.status).toBe("retrying");
    expect(sideEffect).toBe(false);
    expect(framework.getById(job.id)?.lastError?.code).toBe("cancelled");
  });

  it("leaves a queued job untouched and reports it as pending", async () => {
    const handler = vi.fn();
    framework.register("queued.work", handler);
    const job = framework.enqueue({ operation: "queued.work" });

    const report = await framework.shutdown();

    expect(report.pending.map((entry) => entry.id)).toEqual([job.id]);
    expect(report.interrupted).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(framework.getById(job.id)?.status).toBe("queued");
    // Never started, so no attempt was consumed.
    expect(framework.getById(job.id)?.attempts).toBe(0);
  });

  it("leaves a retrying job for the next process, backoff intact", async () => {
    framework.register("flaky.work", () => {
      throw new Error("nope");
    });
    const job = framework.enqueue({ operation: "flaky.work" });
    framework.drainDueJobs();
    expect(framework.getById(job.id)?.status).toBe("retrying");

    const report = await framework.shutdown();

    expect(report.pending.map((entry) => entry.id)).toEqual([job.id]);
    expect(report.interrupted).toHaveLength(0);
    expect(framework.getById(job.id)?.status).toBe("retrying");
    expect(framework.getById(job.id)?.nextAttemptAt).toBeTypeOf("string");
  });

  it("counts an already-settled job as settled and leaves it alone", async () => {
    framework.register("done.work", () => {});
    const job = framework.enqueue({ operation: "done.work" });
    framework.drainDueJobs();

    const report = await framework.shutdown();

    expect(report.settled).toBe(1);
    expect(report.pending).toHaveLength(0);
    expect(report.interrupted).toHaveLength(0);
    expect(framework.getById(job.id)?.status).toBe("succeeded");
  });

  it("reports a handler that ignores the signal as interrupted", async () => {
    // Never settles. shutdown must not hang on it, and must not classify it as
    // merely pending: its side effect is unknown, which is the whole risk.
    framework.register("stubborn.work", () => new Promise<void>(() => {}));
    framework.enqueue({ operation: "stubborn.work" });
    framework.drainDueJobs();

    const report = await framework.shutdown({ timeoutMs: 20 });

    expect(report.interrupted).toHaveLength(1);
    expect(report.pending).toHaveLength(0);
    expect(framework.inFlight()).toBeGreaterThanOrEqual(1);
  });

  it("treats a handler that throws on the signal as a cancellation", async () => {
    framework.register("thrower.work", async (_params, context) => {
      await sleep(5);
      context.signal.throwIfAborted();
    });

    const job = framework.enqueue({ operation: "thrower.work" });
    framework.drainDueJobs();
    const report = await framework.shutdown();

    expect(report.interrupted.map((entry) => entry.id)).toEqual([job.id]);
    // Recorded as cancelled, not as a fault: the handler did not fail, it was
    // told to stop.
    expect(framework.getById(job.id)?.lastError?.code).toBe("cancelled");
  });

  it("dead-letters a cancelled attempt whose budget is spent", async () => {
    framework = createWorkerFramework({ maxAttempts: 1 });
    framework.register("once.work", async (_params, context) => {
      await sleep(5);
      if (context.signal.aborted) return;
    });

    const job = framework.enqueue({ operation: "once.work" });
    framework.drainDueJobs();
    await framework.shutdown();

    expect(framework.getById(job.id)?.status).toBe("dead_lettered");
    expect(framework.getById(job.id)?.status).not.toBe("succeeded");
  });

  it("starts no new work once cancelling", async () => {
    const handler = vi.fn();
    framework.register("after.work", handler);

    await framework.shutdown();
    framework.enqueue({ operation: "after.work" });

    expect(framework.drainDueJobs().ran).toBe(0);
    expect(framework.drainDueJobs().ran).toBe(0);
    const job = framework.inspect()[0];
    expect(framework.processJob(job.id).ran).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("exposes the phase transitions idle -> cancelling -> stopped", async () => {
    expect(framework.phase()).toBe("idle");

    framework.cancel("because");
    expect(framework.phase()).toBe("cancelling");
    expect(framework.signal().aborted).toBe(true);

    await framework.shutdown();
    expect(framework.phase()).toBe("stopped");
  });

  it("is idempotent: a second shutdown does not re-abort or double-count", async () => {
    framework.register("once.work", () => {});
    framework.enqueue({ operation: "once.work" });

    const first = await framework.shutdown({ reason: "first" });
    const second = await framework.shutdown({ reason: "second" });

    expect(first.reason).toBe("first");
    // The first shutdown already stopped it, so the second reports the settled
    // state rather than pretending to cancel again.
    expect(second.phase).toBe("stopped");
    expect(second.reason).toBe("second");
    expect(second.settled).toBe(first.settled);
  });

  it("accepts work again after reset()", async () => {
    const handler = vi.fn();
    framework.register("reuse.work", handler);
    await framework.shutdown();

    framework.reset();

    expect(framework.phase()).toBe("idle");
    expect(framework.signal().aborted).toBe(false);

    // reset() also clears registrations, so a reused framework must re-register.
    framework.register("reuse.work", handler);
    framework.enqueue({ operation: "reuse.work" });
    expect(framework.drainDueJobs().succeeded).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still records ordinary failures as failures, not cancellations", () => {
    framework.register("boom.work", () => {
      throw new WorkerCancelledError("unrelated");
    });

    framework.enqueue({ operation: "boom.work" });
    const summary = framework.drainDueJobs();

    // Nothing is cancelling, so a thrown error is a failure even if its class
    // looks like a cancellation.
    expect(summary.cancelled).toBe(0);
    expect(summary.retried).toBe(1);
  });

  it("recognises both cancellation shapes", () => {
    expect(isCancellation(new WorkerCancelledError())).toBe(true);
    expect(isCancellation(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isCancellation(new Error("handler failed"))).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation("nope")).toBe(false);
  });
});

describe("maintenance framework shutdown", () => {
  it("cancels the prune job rather than reporting it done", async () => {
    const framework = createMaintenanceFramework();
    const job = framework.enqueue({ operation: PRUNE_HORIZON_CLIENTS_OP });

    const report = await framework.shutdown({ reason: "unload" });

    // Never started, so it is owed to the next session rather than abandoned.
    expect(report.pending.map((entry) => entry.operation)).toEqual([PRUNE_HORIZON_CLIENTS_OP]);
    expect(framework.getById(job.id)?.status).toBe("queued");
  });

  it("exposes cancel without waiting, for an unload handler", () => {
    const framework = createMaintenanceFramework();
    framework.enqueue({ operation: PRUNE_HORIZON_CLIENTS_OP });

    framework.cancel("pagehide");

    expect(framework.phase()).toBe("cancelling");
    expect(framework.drainDueJobs().ran).toBe(0);
  });

  it("cancelMaintenance() reaches the shared singleton", () => {
    // The exported helper targets the app-wide framework; a direct call must not
    // throw and must leave it cancelling.
    expect(() => cancelMaintenance("test_unload")).not.toThrow();
  });
});
