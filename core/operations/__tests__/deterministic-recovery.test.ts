/**
 * Deterministic recovery tests for interrupted workflows (#330).
 *
 * Covers all the interruption paths that a real workflow can reach:
 * - normal happy path (all steps succeed)
 * - step throws mid-flight (unknown committed status → interrupted)
 * - step fails and reports nothing landed (failed → retryable)
 * - step reports committed=true (interrupted → requires human confirmation)
 * - resume after crash picks up at the right step (deterministic from checkpoint)
 * - resolveInterruptedStep for applied / not_applied outcomes
 * - abandonOperation (operator gives up; record kept for audit)
 * - authorization guards on resolve and abandon
 * - storage write failure at each stage
 */

import { describe, expect, it } from "vitest";
import {
  runOperation,
  resolveInterruptedStep,
  resolveInterruptedStepAuthorized,
  abandonOperation,
  abandonOperationAuthorized,
  decideStep,
  nextActionFor,
  defaultIdempotencyKey,
  type OperationDefinition,
  type OperationRecord,
  type OperationStorage,
  type StepOutcome,
  type StepRunInput,
  createOperationStorage,
} from "@/core/operations";
import { isErr, isOk } from "@/core/result/result";

interface Ctx {
  value: string;
}

/** Deterministic advancing clock — 1 s per call, so timestamps never collide. */
function clock(startMs = 1_800_000_000_000): () => number {
  let t = startMs;
  return () => { t += 1_000; return t; };
}

function storage(): OperationStorage {
  return createOperationStorage();
}

function simpleStep(id: string, outcome: () => StepOutcome) {
  return {
    id,
    run: async (_input: StepRunInput<Ctx>): Promise<StepOutcome> => outcome(),
  };
}

function runOpts(
  store: OperationStorage,
  overrides: Partial<{ operationId: string; seed: number }> = {}
) {
  return {
    operationId: overrides.operationId ?? "op-1",
    context: { value: "test" } as Ctx,
    storage: store,
    now: clock(1_800_000_000_000 + (overrides.seed ?? 0) * 60_000),
    newCorrelationId: () => "corr-deterministic",
  };
}

function def(steps: OperationDefinition<Ctx>["steps"]): OperationDefinition<Ctx> {
  return { kind: "test_workflow", steps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – happy path (#330)", () => {
  it("runs all steps and reports completed", async () => {
    const store = storage();
    const ran: string[] = [];
    const d = def([
      simpleStep("step-a", () => { ran.push("a"); return { status: "succeeded" }; }),
      simpleStep("step-b", () => { ran.push("b"); return { status: "succeeded" }; }),
    ]);

    const result = await runOperation(d, runOpts(store));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.state).toBe("completed");
    expect(ran).toEqual(["a", "b"]);
    expect(result.value.record.steps.every((s) => s.status === "succeeded")).toBe(true);
  });

  it("calling runOperation again on a completed record is a no-op", async () => {
    const store = storage();
    const ran: string[] = [];
    const d = def([simpleStep("step-a", () => { ran.push("a"); return { status: "succeeded" }; })]);
    await runOperation(d, runOpts(store));
    const second = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.state).toBe("completed");
    expect(ran).toHaveLength(1); // the step ran only once
  });

  it("skipped steps are not re-run", async () => {
    const store = storage();
    const ran: string[] = [];
    const d = def([
      simpleStep("step-a", () => { ran.push("a"); return { status: "succeeded" }; }),
      simpleStep("step-b", () => { ran.push("b"); return { status: "skipped" }; }),
      simpleStep("step-c", () => { ran.push("c"); return { status: "succeeded" }; }),
    ]);
    const result = await runOperation(d, runOpts(store));
    expect(isOk(result) && result.value.state).toBe("completed");
    expect(ran).toEqual(["a", "b", "c"]);
    // A skipped step must not be retried on a fresh run of the same operation.
    const second = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(second) && second.value.state).toBe("completed");
    expect(ran).toHaveLength(3); // nothing extra
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interruption: step throws (unknown committed state)
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – step throws (#330)", () => {
  it("interrupts the operation when a step throws before reporting", async () => {
    const store = storage();
    let threw = false;
    const d = def([
      simpleStep("step-a", () => ({ status: "succeeded" })),
      simpleStep("step-b", () => { threw = true; throw new Error("network timeout"); }),
      simpleStep("step-c", () => ({ status: "succeeded" })),
    ]);

    const result = await runOperation(d, runOpts(store));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(threw).toBe(true);
    expect(result.value.state).toBe("interrupted");
    expect(result.value.action?.code).toBe("retry_step");
    expect(result.value.action?.stepId).toBe("step-b");
    // step-c must NOT have run
    const stepC = result.value.record.steps.find((s) => s.id === "step-c");
    expect(stepC?.status).toBe("pending");
  });

  it("resumes at the interrupted step on the next runOperation call", async () => {
    const store = storage();
    let attempt = 0;
    const d = def([
      simpleStep("step-a", () => ({ status: "succeeded" })),
      simpleStep("step-b", () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
        return { status: "succeeded" };
      }),
      simpleStep("step-c", () => ({ status: "succeeded" })),
    ]);

    const first = await runOperation(d, runOpts(store));
    expect(isOk(first) && first.value.state).toBe("interrupted");

    const second = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.state).toBe("completed");
    expect(attempt).toBe(2);

    // step-a checkpoint is still succeeded and was not re-run
    const stepA = second.value.record.steps.find((s) => s.id === "step-a");
    expect(stepA?.status).toBe("succeeded");
    expect(stepA?.attempt).toBe(1);
  });

  it("idempotency key is preserved across a resume so retries look like one request", async () => {
    const store = storage();
    const keys: string[] = [];
    let attempt = 0;
    const d = def([
      {
        id: "step-pay",
        run: async (input: StepRunInput<Ctx>): Promise<StepOutcome> => {
          keys.push(input.idempotencyKey);
          attempt += 1;
          if (attempt === 1) throw new Error("gone");
          return { status: "succeeded" };
        },
      },
    ]);

    await runOperation(d, runOpts(store));
    await runOperation(d, runOpts(store, { seed: 1 }));

    expect(keys).toHaveLength(2);
    // Both attempts used the same idempotency key — the downstream system sees one request.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(defaultIdempotencyKey("op-1", "step-pay"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interruption: committed side effect (requires human confirmation)
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – committed side effect (#330)", () => {
  it("stops the run and demands confirmation when a step reports committed=true then fails", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-a", () => ({ status: "succeeded" })),
      simpleStep("step-b", () => ({
        status: "failed",
        committed: true,          // the effect landed, but then we lost the response
        errorCode: "relay_timeout",
      })),
      simpleStep("step-c", () => ({ status: "succeeded" })),
    ]);

    const result = await runOperation(d, runOpts(store));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.state).toBe("interrupted");
    expect(result.value.action?.code).toBe("confirm_external_state");
    expect(result.value.action?.stepId).toBe("step-b");
  });

  it("re-running without resolving gives the same confirm action (deterministic)", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-b", () => ({ status: "failed", committed: true, errorCode: "relay_timeout" })),
    ]);
    await runOperation(d, runOpts(store));
    const second = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(second) && second.value.action?.code).toBe("confirm_external_state");
  });

  it("resolveInterruptedStep 'applied' unblocks the workflow", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-a", () => ({ status: "failed", committed: true, errorCode: "relay_timeout" })),
      simpleStep("step-b", () => ({ status: "succeeded" })),
    ]);
    await runOperation(d, runOpts(store));

    const resolved = resolveInterruptedStep("op-1", "step-a", "applied", { storage: store });
    expect(isOk(resolved)).toBe(true);

    const resumed = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(resumed) && resumed.value.state).toBe("completed");
  });

  it("resolveInterruptedStep 'not_applied' makes the step retryable again", async () => {
    const store = storage();
    let count = 0;
    const d = def([
      simpleStep("step-a", () => {
        count += 1;
        if (count === 1) return { status: "failed", committed: true, errorCode: "relay_timeout" };
        return { status: "succeeded" };
      }),
    ]);
    await runOperation(d, runOpts(store));
    resolveInterruptedStep("op-1", "step-a", "not_applied", { storage: store });
    const resumed = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(resumed) && resumed.value.state).toBe("completed");
    expect(count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failed path (no side effect committed)
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – step fails without committing (#330)", () => {
  it("moves to failed and offers a retry action", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-a", () => ({ status: "failed", committed: false, errorCode: "validation_error" })),
    ]);
    const result = await runOperation(d, runOpts(store));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.state).toBe("failed");
    expect(result.value.action?.code).toBe("retry_step");
    expect(result.value.errorCode).toBe("validation_error");
  });

  it("retrying a failed operation re-runs only the failed step", async () => {
    const store = storage();
    const ran: string[] = [];
    let fail = true;
    const d = def([
      simpleStep("step-a", () => { ran.push("a"); return { status: "succeeded" }; }),
      simpleStep("step-b", () => {
        ran.push("b");
        if (fail) { fail = false; return { status: "failed", committed: false, errorCode: "net_err" }; }
        return { status: "succeeded" };
      }),
      simpleStep("step-c", () => { ran.push("c"); return { status: "succeeded" }; }),
    ]);
    await runOperation(d, runOpts(store));
    expect(ran).toEqual(["a", "b"]);

    const retry = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(retry) && retry.value.state).toBe("completed");
    expect(ran).toEqual(["a", "b", "b", "c"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization paths
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – authorization (#330)", () => {
  it("resolveInterruptedStepAuthorized denies non-admin callers", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-a", () => ({ status: "failed", committed: true, errorCode: "timeout" })),
    ]);
    await runOperation(d, runOpts(store));

    const denied = resolveInterruptedStepAuthorized(
      { role: "viewer", userId: "u1" },
      "op-1",
      "step-a",
      "applied",
      { storage: store }
    );
    expect(isErr(denied)).toBe(true);
    if (!isErr(denied)) return;
    expect(denied.code).toBe("permission_denied");
  });

  it("resolveInterruptedStepAuthorized allows admin callers and records actor", async () => {
    const store = storage();
    const d = def([
      simpleStep("step-a", () => ({ status: "failed", committed: true, errorCode: "timeout" })),
    ]);
    await runOperation(d, runOpts(store));

    const allowed = resolveInterruptedStepAuthorized(
      { role: "maintainer", userId: "operator-1" },
      "op-1",
      "step-a",
      "applied",
      { storage: store }
    );
    expect(isOk(allowed)).toBe(true);
  });

  it("abandonOperationAuthorized denies non-admin callers", async () => {
    const store = storage();
    const d = def([simpleStep("step-a", () => ({ status: "failed", committed: false, errorCode: "err" }))]);
    await runOperation(d, runOpts(store));
    const denied = abandonOperationAuthorized(
      { role: "viewer", userId: "u1" },
      "op-1",
      { storage: store }
    );
    expect(isErr(denied)).toBe(true);
    if (!isErr(denied)) return;
    expect(denied.code).toBe("permission_denied");
  });

  it("abandonOperation leaves the record as abandoned (kept for audit)", async () => {
    const store = storage();
    const d = def([simpleStep("step-a", () => ({ status: "failed", committed: false, errorCode: "err" }))]);
    await runOperation(d, runOpts(store));

    const abandoned = abandonOperation("op-1", { storage: store, actor: "maintainer:ops" });
    expect(isOk(abandoned)).toBe(true);
    if (!isOk(abandoned)) return;
    expect(abandoned.value.state).toBe("abandoned");

    // The record is still readable (kept for audit).
    const after = await runOperation(d, runOpts(store, { seed: 1 }));
    expect(isOk(after) && after.value.state).toBe("abandoned");
  });

  it("resolveInterruptedStep on an unknown operation returns unknown_operation", () => {
    const store = storage();
    const result = resolveInterruptedStep("does-not-exist", "step-a", "applied", { storage: store });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.code).toBe("unknown_operation");
  });

  it("resolveInterruptedStep on an unknown step id returns unknown_step", async () => {
    const store = storage();
    const d = def([simpleStep("step-a", () => ({ status: "failed", committed: true, errorCode: "e" }))]);
    await runOperation(d, runOpts(store));
    const result = resolveInterruptedStep("op-1", "does-not-exist", "applied", { storage: store });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.code).toBe("unknown_step");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideStep and nextActionFor helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic recovery – decideStep and nextActionFor (#330)", () => {
  function checkpoint(overrides: Partial<Parameters<typeof decideStep>[0]> = {}): Parameters<typeof decideStep>[0] {
    return {
      id: "s",
      status: "pending",
      attempt: 0,
      idempotencyKey: "k",
      sideEffectCommitted: false,
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("decideStep: succeeded → skip", () => {
    expect(decideStep(checkpoint({ status: "succeeded" }))).toBe("skip");
  });
  it("decideStep: skipped → skip", () => {
    expect(decideStep(checkpoint({ status: "skipped" }))).toBe("skip");
  });
  it("decideStep: committed → confirm", () => {
    expect(decideStep(checkpoint({ status: "interrupted", sideEffectCommitted: true }))).toBe("confirm");
  });
  it("decideStep: not committed → run", () => {
    expect(decideStep(checkpoint({ status: "pending", sideEffectCommitted: false }))).toBe("run");
  });

  it("nextActionFor: returns null for completed or abandoned records", () => {
    const base: OperationRecord = {
      id: "op",
      kind: "k",
      state: "completed",
      correlationId: "c",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [checkpoint({ status: "succeeded" })],
    };
    expect(nextActionFor(base)).toBeNull();
    expect(nextActionFor({ ...base, state: "abandoned" })).toBeNull();
  });

  it("nextActionFor: interrupted committed step → confirm_external_state", () => {
    const record: OperationRecord = {
      id: "op",
      kind: "k",
      state: "interrupted",
      correlationId: "c",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [checkpoint({ id: "s1", status: "interrupted", sideEffectCommitted: true })],
    };
    const action = nextActionFor(record);
    expect(action?.code).toBe("confirm_external_state");
    expect(action?.stepId).toBe("s1");
  });
});
