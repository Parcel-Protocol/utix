import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import { createJobCancellationManager } from "@/core/workers/cancellation";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-1" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };
const SERVICE: AuthContext = { role: "service", userId: "svc-1" };
const OWNER: AuthContext = { role: "viewer", userId: "owner-42" };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("safe job cancellation: normal paths", () => {
  it("completes a normal job without invoking cancellation cleanup hooks", async () => {
    const manager = createJobCancellationManager();
    const cleanup = vi.fn();

    const result = await manager.runJob(
      { jobId: "job-normal-1", operation: "export.csv", ownerId: "owner-42" },
      async (ctx) => {
        ctx.registerCleanup("release-lock", cleanup);
        return "done";
      }
    );

    expect(result).toEqual({ ok: true, value: "done" });
    expect(cleanup).not.toHaveBeenCalled();

    const snapshot = manager.getJob("job-normal-1");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.forced).toBe(false);
    expect(snapshot?.cleanupSteps[0]?.status).toBe("pending");
  });

  it("cancels a running job cooperatively and runs cleanup hooks in LIFO order", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();
    const order: string[] = [];

    const runPromise = manager.runJob(
      { jobId: "job-cancel-1", operation: "ledger.backfill", ownerId: "owner-42" },
      async (ctx) => {
        ctx.registerCleanup("close-handle", () => {
          order.push("close-handle");
        });
        ctx.registerCleanup("delete-temp-file", () => {
          order.push("delete-temp-file");
        });
        ctx.registerCleanup("release-lock", () => {
          order.push("release-lock");
        });

        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;

    const cancelResult = await manager.cancelJob("job-cancel-1", MAINTAINER, {
      reason: "operator_requested"
    });
    const runResult = await runPromise;

    expect(runResult).toEqual({ ok: false, code: "job_cancelled" });
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) {
      expect(cancelResult.value.idempotentReplay).toBe(false);
      expect(cancelResult.value.job.status).toBe("cancelled");
      expect(cancelResult.value.job.forced).toBe(false);
      expect(cancelResult.value.job.cancelReason).toBe("operator_requested");
      expect(cancelResult.value.job.cancelledBy).toBe("maintainer:ops-1");
      expect(cancelResult.value.job.cleanupSteps.every((s) => s.status === "succeeded")).toBe(true);
    }

    expect(order).toEqual(["release-lock", "delete-temp-file", "close-handle"]);
  });

  it("is idempotent when cancelJob is called again on an already-cancelled job", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();
    const cleanup = vi.fn();

    const runPromise = manager.runJob(
      { jobId: "job-idemp-1", operation: "sync.run" },
      async (ctx) => {
        ctx.registerCleanup("release-lock", cleanup);
        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;

    const first = await manager.cancelJob("job-idemp-1", MAINTAINER);
    await runPromise;
    const second = await manager.cancelJob("job-idemp-1", MAINTAINER);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.idempotentReplay).toBe(true);
      expect(second.value.job.status).toBe("cancelled");
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("safe job cancellation: authorization paths", () => {
  it("rejects unauthorized viewer and service roles without aborting or running cleanup", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();
    const finish = deferred();
    const cleanup = vi.fn();
    let aborted = false;

    const runPromise = manager.runJob(
      { jobId: "job-auth-1", operation: "export.batch", ownerId: "owner-42" },
      async (ctx) => {
        ctx.registerCleanup("release-lock", cleanup);
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        started.resolve();
        await finish.promise;
        return "ok";
      }
    );

    await started.promise;

    const viewerRes = await manager.cancelJob("job-auth-1", VIEWER);
    const serviceRes = await manager.cancelJob("job-auth-1", SERVICE);

    expect(viewerRes).toEqual({ ok: false, code: "permission_denied" });
    expect(serviceRes).toEqual({ ok: false, code: "permission_denied" });
    expect(aborted).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(manager.getJob("job-auth-1")?.status).toBe("running");

    finish.resolve();
    const runResult = await runPromise;
    expect(runResult).toEqual({ ok: true, value: "ok" });
  });

  it("allows the job owner to cancel their own long-running job", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();

    const runPromise = manager.runJob(
      { jobId: "job-owner-1", operation: "report.build", ownerId: "owner-42" },
      async (ctx) => {
        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;

    const res = await manager.cancelJob("job-owner-1", OWNER, { reason: "user_cancelled" });
    await runPromise;

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.job.status).toBe("cancelled");
      expect(res.value.job.cancelledBy).toBe("viewer:owner-42");
    }
  });
});

describe("safe job cancellation: failure and retry paths", () => {
  it("isolates cleanup hook failures, transitions to cleanup_failed, and retries only failed hooks", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();

    let shouldFailTempCleanup = true;
    const lockCleanup = vi.fn();
    const tempCleanup = vi.fn(() => {
      if (shouldFailTempCleanup) {
        throw new Error("disk busy");
      }
    });
    const handleCleanup = vi.fn();

    const runPromise = manager.runJob(
      { jobId: "job-fail-1", operation: "archive.compact", ownerId: "owner-42" },
      async (ctx) => {
        ctx.registerCleanup("close-handle", handleCleanup);
        ctx.registerCleanup("delete-temp", tempCleanup);
        ctx.registerCleanup("release-lock", lockCleanup);
        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;

    const cancelRes = await manager.cancelJob("job-fail-1", MAINTAINER);
    await runPromise;

    expect(cancelRes).toEqual({ ok: false, code: "cleanup_failed" });
    // All three hooks were attempted despite the middle one throwing.
    expect(lockCleanup).toHaveBeenCalledTimes(1);
    expect(tempCleanup).toHaveBeenCalledTimes(1);
    expect(handleCleanup).toHaveBeenCalledTimes(1);

    const failedSnapshot = manager.getJob("job-fail-1");
    expect(failedSnapshot?.status).toBe("cleanup_failed");
    expect(failedSnapshot?.cleanupSteps.find((s) => s.name === "delete-temp")?.status).toBe("failed");
    expect(failedSnapshot?.cleanupSteps.find((s) => s.name === "delete-temp")?.lastError?.message).toBe("disk busy");

    // Unauthorized retry is rejected.
    const unauthRetry = await manager.retryCleanup("job-fail-1", VIEWER);
    expect(unauthRetry).toEqual({ ok: false, code: "permission_denied" });

    // Authorized retry skips already-succeeded hooks and recovers to cancelled.
    shouldFailTempCleanup = false;
    const retryRes = await manager.retryCleanup("job-fail-1", MAINTAINER);

    expect(retryRes.ok).toBe(true);
    if (retryRes.ok) {
      expect(retryRes.value.job.status).toBe("cancelled");
      expect(retryRes.value.job.cleanupSteps.every((s) => s.status === "succeeded")).toBe(true);
    }

    // Already-succeeded hooks were NOT re-run; only the failed hook ran a second time.
    expect(lockCleanup).toHaveBeenCalledTimes(1);
    expect(handleCleanup).toHaveBeenCalledTimes(1);
    expect(tempCleanup).toHaveBeenCalledTimes(2);
  });

  it("marks cleanup as failed when a cleanup hook exceeds cleanupTimeoutMs", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();

    const runPromise = manager.runJob(
      { jobId: "job-timeout-1", operation: "export.slow" },
      async (ctx) => {
        ctx.registerCleanup("hung-cleanup", async () => {
          await new Promise(() => {
            // intentionally never resolves
          });
        });
        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;

    const res = await manager.cancelJob("job-timeout-1", MAINTAINER, {
      cleanupTimeoutMs: 25
    });
    await runPromise;

    expect(res).toEqual({ ok: false, code: "cleanup_failed" });
    const snapshot = manager.getJob("job-timeout-1");
    expect(snapshot?.status).toBe("cleanup_failed");
    expect(snapshot?.cleanupSteps[0]?.lastError?.code).toBe("CleanupTimeoutError");
  });
});

describe("safe job cancellation: edge cases", () => {
  it("forces cleanup when a non-cooperative handler ignores AbortSignal past gracePeriodMs", async () => {
    const manager = createJobCancellationManager();
    const started = deferred();
    const unblock = deferred();
    const cleanup = vi.fn();

    const runPromise = manager.runJob(
      { jobId: "job-forced-1", operation: "compute.heavy" },
      async (ctx) => {
        ctx.registerCleanup("release-gpu", cleanup);
        started.resolve();
        await unblock.promise;
        return "late-result";
      }
    );

    await started.promise;

    const cancelRes = await manager.cancelJob("job-forced-1", MAINTAINER, {
      gracePeriodMs: 20
    });

    expect(cancelRes.ok).toBe(true);
    if (cancelRes.ok) {
      expect(cancelRes.value.job.status).toBe("cancelled");
      expect(cancelRes.value.job.forced).toBe(true);
    }
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Even when the handler eventually returns, it must not be marked completed.
    unblock.resolve();
    const runRes = await runPromise;
    expect(runRes).toEqual({ ok: false, code: "job_cancelled" });
    expect(manager.getJob("job-forced-1")?.status).toBe("cancelled");
  });

  it("propagates parentSignal abort to the job signal", async () => {
    const manager = createJobCancellationManager();
    const parentController = new AbortController();
    const started = deferred();
    let childAborted = false;

    const runPromise = manager.runJob(
      {
        jobId: "job-parent-1",
        operation: "sync.stream",
        parentSignal: parentController.signal
      },
      async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          childAborted = true;
        });
        started.resolve();
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
    );

    await started.promise;
    parentController.abort(new Error("framework shutdown"));

    const res = await runPromise;
    expect(childAborted).toBe(true);
    expect(res).toEqual({ ok: false, code: "job_cancelled" });
  });

  it("returns structured errors for unknown, already-completed, duplicate, and non-failed-cleanup jobs", async () => {
    const manager = createJobCancellationManager();

    expect(await manager.cancelJob("missing", MAINTAINER)).toEqual({
      ok: false,
      code: "unknown_job"
    });
    expect(await manager.retryCleanup("missing", MAINTAINER)).toEqual({
      ok: false,
      code: "unknown_job"
    });

    await manager.runJob({ jobId: "job-done", operation: "noop" }, async () => "ok");

    expect(await manager.cancelJob("job-done", MAINTAINER)).toEqual({
      ok: false,
      code: "already_completed"
    });
    expect(await manager.retryCleanup("job-done", MAINTAINER)).toEqual({
      ok: false,
      code: "not_cleanup_failed"
    });
    expect(
      await manager.runJob({ jobId: "job-done", operation: "noop" }, async () => "dup")
    ).toEqual({
      ok: false,
      code: "duplicate_job"
    });
  });
});
