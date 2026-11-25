import { describe, expect, it } from "vitest";
import {
  createOperationStorage,
  createSideEffectDispatcher,
  rollbackOperation,
  rollbackOperationAuthorized,
  runOperation,
  type OperationDefinition,
  type OperationStorage,
  type StepDefinition
} from "@/core/operations";
import type { AuthContext } from "@/core/auth/middleware";

interface TestContext {
  readonly accountId: string;
  readonly balance: number;
}

function testOptions(storage: OperationStorage, opId = "op-rollback-1") {
  return {
    operationId: opId,
    context: { accountId: "GAA...TEST", balance: 100 },
    storage,
    now: () => 1_700_000_000_000,
    newCorrelationId: () => "corr-rb-1"
  };
}

describe("Deterministic Rollback for Failed External Side Effects (Issue #350)", () => {
  it("normal path: compensates committed external side effects in reverse order (LIFO)", async () => {
    const storage = createOperationStorage();
    const compensationLog: string[] = [];
    const keysUsed: string[] = [];

    const definition: OperationDefinition<TestContext> = {
      kind: "escrow_settlement",
      steps: [
        {
          id: "reserve_funds",
          run: () => ({ status: "succeeded", output: { reserved: 50 }, committed: true }),
          rollback: (input) => {
            compensationLog.push("unreserve_funds");
            keysUsed.push(input.idempotencyKey);
            return { status: "rolled_back", output: { unreserved: 50 } };
          }
        },
        {
          id: "lock_asset",
          run: () => ({ status: "succeeded", output: { lockedAsset: "USDC" }, committed: true }),
          rollback: (input) => {
            compensationLog.push("unlock_asset");
            keysUsed.push(input.idempotencyKey);
            return { status: "rolled_back", output: { unlockedAsset: "USDC" } };
          }
        },
        {
          id: "submit_payment",
          run: () => ({ status: "failed", errorCode: "upstream_stellar_horizon_400", committed: false })
        }
      ]
    };

    // 1. Run operation: fails at step 3
    const runResult = await runOperation(definition, testOptions(storage));
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;
    expect(runResult.value.state).toBe("failed");
    expect(runResult.value.errorCode).toBe("upstream_stellar_horizon_400");

    // 2. Rollback operation: must compensate lock_asset THEN reserve_funds (LIFO)
    const rollbackResult = await rollbackOperation(definition, testOptions(storage), "payment_failed");
    expect(rollbackResult.ok).toBe(true);
    if (!rollbackResult.ok) return;

    expect(compensationLog).toEqual(["unlock_asset", "unreserve_funds"]);
    expect(keysUsed[0]).toBe("operation:op-rollback-1:step:lock_asset:rollback");
    expect(keysUsed[1]).toBe("operation:op-rollback-1:step:reserve_funds:rollback");

    expect(rollbackResult.value.rolledBackAt).toBeDefined();
    const reserveCheckpoint = rollbackResult.value.steps.find((s) => s.id === "reserve_funds");
    const lockCheckpoint = rollbackResult.value.steps.find((s) => s.id === "lock_asset");
    expect(reserveCheckpoint?.rollbackStatus).toBe("rolled_back");
    expect(lockCheckpoint?.rollbackStatus).toBe("rolled_back");
  });

  it("failure path: records rollback_failed when a compensation handler fails or throws", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<TestContext> = {
      kind: "ticket_disbursement",
      steps: [
        {
          id: "step_one",
          run: () => ({ status: "succeeded", output: "ok1", committed: true }),
          rollback: () => ({ status: "failed", errorCode: "compensation_network_timeout" })
        },
        {
          id: "step_two",
          run: () => ({ status: "failed", errorCode: "step_two_failed", committed: false })
        }
      ]
    };

    await runOperation(definition, testOptions(storage));
    const rbResult = await rollbackOperation(definition, testOptions(storage));

    expect(rbResult.ok).toBe(false);
    if (rbResult.ok) return;
    expect(rbResult.code).toBe("rollback_failed");

    const record = storage.read("op-rollback-1");
    expect(record).toBeDefined();
    const stepOne = record?.steps.find((s) => s.id === "step_one");
    expect(stepOne?.rollbackStatus).toBe("rollback_failed");
    expect(stepOne?.rollbackErrorCode).toBe("compensation_network_timeout");
  });

  it("retry path: re-attempts a failed compensation with the exact same rollback idempotency key", async () => {
    const storage = createOperationStorage();
    let attemptCount = 0;
    const capturedKeys: string[] = [];

    const definition: OperationDefinition<TestContext> = {
      kind: "retryable_rollback",
      steps: [
        {
          id: "debit_ledger",
          run: () => ({ status: "succeeded", committed: true }),
          rollback: (input) => {
            attemptCount++;
            capturedKeys.push(input.idempotencyKey);
            if (attemptCount === 1) {
              return { status: "failed", errorCode: "temporary_rpc_unavailable" };
            }
            return { status: "rolled_back" };
          }
        },
        {
          id: "credit_ledger",
          run: () => ({ status: "failed", errorCode: "fatal_credit_error" })
        }
      ]
    };

    await runOperation(definition, testOptions(storage));

    // First rollback attempt: fails
    const firstRb = await rollbackOperation(definition, testOptions(storage));
    expect(firstRb.ok).toBe(false);
    expect(attemptCount).toBe(1);

    // Second rollback attempt (retry): succeeds
    const secondRb = await rollbackOperation(definition, testOptions(storage));
    expect(secondRb.ok).toBe(true);
    expect(attemptCount).toBe(2);

    // Both attempts must have reused the exact same rollback idempotency key
    expect(capturedKeys[0]).toBe("operation:op-rollback-1:step:debit_ledger:rollback");
    expect(capturedKeys[1]).toBe("operation:op-rollback-1:step:debit_ledger:rollback");
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
  });

  it("authorization path: allows maintainer with admin:recovery, rejects viewer role", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<TestContext> = {
      kind: "authorized_flow",
      steps: [
        {
          id: "step_a",
          run: () => ({ status: "succeeded", committed: true }),
          rollback: () => ({ status: "rolled_back" })
        },
        {
          id: "step_b",
          run: () => ({ status: "failed", errorCode: "aborted" })
        }
      ]
    };

    await runOperation(definition, testOptions(storage));

    const viewerAuth: AuthContext = { role: "viewer", userId: "user-123" };
    const maintainerAuth: AuthContext = { role: "maintainer", userId: "maint-admin" };

    // Viewer denied
    const denied = await rollbackOperationAuthorized(viewerAuth, definition, testOptions(storage));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("permission_denied");

    // Maintainer allowed
    const allowed = await rollbackOperationAuthorized(maintainerAuth, definition, testOptions(storage));
    expect(allowed.ok).toBe(true);
  });

  it("edge case: skips steps that never committed side effects", async () => {
    const storage = createOperationStorage();
    const rollbackCalled: string[] = [];

    const definition: OperationDefinition<TestContext> = {
      kind: "read_only_step_flow",
      steps: [
        {
          id: "read_balance",
          run: () => ({ status: "succeeded", committed: false }),
          rollback: () => {
            rollbackCalled.push("read_balance");
            return { status: "rolled_back" };
          }
        },
        {
          id: "fail_step",
          run: () => ({ status: "failed", errorCode: "error_x" })
        }
      ]
    };

    await runOperation(definition, testOptions(storage));
    const result = await rollbackOperation(definition, testOptions(storage));
    expect(result.ok).toBe(true);
    // Since read_balance was committed: false, its rollback was not required
    expect(rollbackCalled).toHaveLength(0);
  });

  describe("createSideEffectDispatcher Rollback", () => {
    function createMemoryStore<T>() {
      const map = new Map<string, any>();
      return {
        read: (id: string) => map.get(id),
        write: (job: any) => void map.set(job.id, job),
        list: () => [...map.values()]
      };
    }

    it("rolls back a dispatched external side effect and handles retries idempotently", async () => {
      const store = createMemoryStore<{ amount: number }>();
      const dispatcher = createSideEffectDispatcher<{ amount: number }>({
        store,
        maxAttempts: 2,
        newId: () => "job-side-1"
      });

      const submitted = dispatcher.submit({
        operation: "stellar.payment",
        idempotencyKey: "tx-pay-999",
        payload: { amount: 500 }
      });

      // Run and succeed
      await dispatcher.run(submitted.job.id, async () => {});
      expect(store.read("job-side-1")?.status).toBe("succeeded");

      // Rollback external side effect
      let undoCalls = 0;
      const rb1 = await dispatcher.rollback("job-side-1", async (job) => {
        undoCalls++;
        expect(job.payload.amount).toBe(500);
      });
      expect(rb1.ok).toBe(true);
      expect(store.read("job-side-1")?.status).toBe("rolled_back");
      expect(undoCalls).toBe(1);

      // Re-running rollback on already rolled_back job is an idempotent no-op
      const rb2 = await dispatcher.rollback("job-side-1", async () => {
        undoCalls++;
      });
      expect(rb2.ok).toBe(true);
      expect(undoCalls).toBe(1);
    });

    it("verifies authorization on side effect rollback", async () => {
      const store = createMemoryStore<string>();
      const dispatcher = createSideEffectDispatcher<string>({
        store,
        maxAttempts: 2,
        newId: () => "job-side-2"
      });

      const submitted = dispatcher.submit({
        operation: "contract.invoke",
        idempotencyKey: "key-contract-2",
        payload: "invoke_data"
      });
      await dispatcher.run(submitted.job.id, () => {});

      const viewer: AuthContext = { role: "viewer" };
      const maintainer: AuthContext = { role: "maintainer" };

      const denied = await dispatcher.rollbackAuthorized(viewer, "job-side-2", async () => {});
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.code).toBe("permission_denied");

      const allowed = await dispatcher.rollbackAuthorized(maintainer, "job-side-2", async () => {});
      expect(allowed.ok).toBe(true);
      expect(store.read("job-side-2")?.status).toBe("rolled_back");
    });
  });
});

