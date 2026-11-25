/**
 * Malformed payload and replay attack fixtures for the worker submit path (#333).
 *
 * Malformed: every fixture in `MALFORMED_SUBMIT_FIXTURES` is refused with its
 * violation, before quota is charged or an idempotency claim is recorded, so a
 * corrected retry under the same key is not blocked. Boundary fixtures are
 * accepted.
 *
 * Replay: a retried submission replays the original job; a key reused for a
 * different payload or operation is a conflict; a malformed replay of a valid
 * key is refused at the boundary rather than replaying.
 */

import { describe, expect, it } from "vitest";
import { validateJobInput } from "@/core/workers/job-input";
import { createWorkerFramework } from "@/core/workers/queue";
import { BOUNDARY_SUBMIT_FIXTURES, MALFORMED_SUBMIT_FIXTURES } from "./fixtures/submitAttacks";

let keySeq = 0;
const freshKey = () => `attack-fixture-${String(++keySeq).padStart(4, "0")}`;

describe("malformed submit fixtures", () => {
  it.each(MALFORMED_SUBMIT_FIXTURES.map((f) => [f.name, f] as const))("refuses %s", (_name, fixture) => {
    expect(validateJobInput(fixture.input)).toBe(fixture.violation);

    const framework = createWorkerFramework();
    const key = freshKey();
    const result = framework.submit({ ...fixture.input, idempotencyKey: key });
    expect(result).toEqual({ ok: false, code: "invalid_job_input", detail: fixture.violation });

    // Nothing was queued, charged or claimed.
    expect(framework.inspect()).toHaveLength(0);
    expect(framework.idempotency().lookup(key).ok).toBe(false);
  });

  it.each(BOUNDARY_SUBMIT_FIXTURES.map((f) => [f.name, f] as const))("accepts %s", (_name, fixture) => {
    expect(validateJobInput(fixture.input)).toBeNull();
    const framework = createWorkerFramework();
    const result = framework.submit({ ...fixture.input, idempotencyKey: freshKey() });
    expect(result.ok).toBe(true);
  });

  it("lets a corrected retry reuse the key a malformed submission was refused under", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    expect(framework.submit({ operation: "ticket.reissue", maxAttempts: Number.NaN, idempotencyKey: key }).ok).toBe(false);
    const corrected = framework.submit({ operation: "ticket.reissue", maxAttempts: 3, idempotencyKey: key });
    expect(corrected.ok && corrected.value.replayed).toBe(false);
  });

  it("does not let a NaN retry budget create a job that retries forever", () => {
    const framework = createWorkerFramework();
    const result = framework.submit({
      operation: "ticket.reissue",
      maxAttempts: Number.NaN,
      idempotencyKey: freshKey()
    });
    expect(result.ok).toBe(false);
    expect(framework.inspect("queued")).toHaveLength(0);
  });
});

describe("replay attack fixtures", () => {
  it("replays the original job for a byte-identical retry", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    const input = { operation: "payout.send", params: { to: "G-dest", amount: "10" }, idempotencyKey: key };
    const first = framework.submit(input);
    const second = framework.submit({ ...input, params: { amount: "10", to: "G-dest" } });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.job.id).toBe(first.value.job.id);
    expect(framework.inspect()).toHaveLength(1);
  });

  it("treats a key reused with a mutated payload as a conflict", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    framework.submit({ operation: "payout.send", params: { amount: "10" }, idempotencyKey: key });
    const mutated = framework.submit({ operation: "payout.send", params: { amount: "1000" }, idempotencyKey: key });
    expect(mutated.ok === false && mutated.code).toBe("idempotency_key_conflict");
    expect(framework.inspect()).toHaveLength(1);
  });

  it("treats a key reused for another operation as a conflict", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    framework.submit({ operation: "payout.send", idempotencyKey: key });
    const crossOp = framework.submit({ operation: "payout.refund", idempotencyKey: key });
    expect(crossOp.ok === false && crossOp.code).toBe("idempotency_key_conflict");
  });

  it("treats a raised retry budget under the same key as a conflict", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    framework.submit({ operation: "payout.send", maxAttempts: 1, idempotencyKey: key });
    const escalated = framework.submit({ operation: "payout.send", maxAttempts: 100, idempotencyKey: key });
    expect(escalated.ok === false && escalated.code).toBe("idempotency_key_conflict");
  });

  it("refuses a malformed replay of a valid key at the boundary, without replaying", () => {
    const framework = createWorkerFramework();
    const key = freshKey();
    const original = framework.submit({ operation: "payout.send", params: { amount: "10" }, idempotencyKey: key });
    expect(original.ok).toBe(true);

    const polluted = framework.submit({
      operation: "payout.send",
      params: JSON.parse('{"amount":"10","__proto__":{"approved":true}}') as Record<string, unknown>,
      idempotencyKey: key
    });
    expect(polluted).toEqual({ ok: false, code: "invalid_job_input", detail: "forbidden_param_key" });
    // The recorded outcome is intact, so the genuine retry still replays.
    const retry = framework.submit({ operation: "payout.send", params: { amount: "10" }, idempotencyKey: key });
    expect(retry.ok && retry.value.replayed).toBe(true);
  });

  it("replays after the job has run, without running it again", async () => {
    const framework = createWorkerFramework();
    let runs = 0;
    framework.register("payout.send", () => {
      runs += 1;
    });
    const key = freshKey();
    framework.submit({ operation: "payout.send", idempotencyKey: key });
    await framework.drain();
    const replay = framework.submit({ operation: "payout.send", idempotencyKey: key });
    await framework.drain();

    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(runs).toBe(1);
  });

  it("rejects a missing or malformed idempotency key on a valid payload", () => {
    const framework = createWorkerFramework();
    const missing = framework.submit({ operation: "payout.send" });
    expect(missing.ok === false && missing.code).toBe("idempotency_key_missing");
    const short = framework.submit({ operation: "payout.send", idempotencyKey: "nope" });
    expect(short.ok === false && short.code).toBe("idempotency_key_invalid");
  });
});
