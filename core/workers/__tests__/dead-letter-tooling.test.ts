import { describe, expect, it } from "vitest";
import { createWorkerFramework } from "../queue";
import { inspectDeadLetters, retryDeadLetter } from "../dead-letter-tooling";

describe("maintainer dead-letter inspection and safe recovery", () => {
  it("requires admin permission for inspection and retry", () => {
    const worker = createWorkerFramework();
    worker.register("error", () => { throw new Error("fail"); }, { maxAttempts: 1 });
    const job = worker.enqueue({ operation: "error", params: { secret: "should_not_appear" }, maxAttempts: 1 });
    worker.drainDueJobs();
    expect(worker.getById(job.id)?.status).toBe("dead_lettered");
    expect(inspectDeadLetters(worker, { role: "viewer" })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(retryDeadLetter(worker, { role: "viewer" }, job.id, { confirm: job.id })).toMatchObject({ ok: false, code: "unauthorized" });
    const listed = inspectDeadLetters(worker, { role: "maintainer" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw Error("should list");
    expect(listed.value).toHaveLength(1);
    expect(JSON.stringify(listed.value)).not.toContain("should_not_appear");
  });

  it("requires exact confirmation and recovers idempotently preserving trace", () => {
    const worker = createWorkerFramework();
    worker.register("error", () => { throw new Error("fail"); }, { maxAttempts: 1 });
    const job = worker.enqueue({ operation: "error", params: {}, maxAttempts: 1, correlationId: "corr-retry" });
    worker.drainDueJobs();
    expect(retryDeadLetter(worker, { role: "maintainer" }, job.id, { confirm: "other" })).toMatchObject({ ok: false, code: "confirmation_required" });
    const first = retryDeadLetter(worker, { role: "maintainer" }, job.id, { confirm: job.id });
    const second = retryDeadLetter(worker, { role: "maintainer" }, job.id, { confirm: job.id });
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) throw Error("should recover");
    expect(first.value.correlationId).toBe("corr-retry");
    expect(worker.getById(job.id)?.status).toBe("dead_lettered");
    expect(worker.getById(first.value.replacement)?.recoveredFrom).toBe(job.id);
  });
});
