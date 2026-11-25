import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import type { Role } from "@/core/auth/types";
import {
  classifyPartialFailure,
  createOperationStorage,
  executeOperatorAction,
  getOperatorDashboard,
  isUnresolvedPartialFailure,
  runOperation,
  type OperationDefinition,
  type OperationRecord,
  type OperationStorage
} from "@/core/operations";
import { isErr, isOk } from "@/core/result/result";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-1" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };
const SERVICE: AuthContext = { role: "service", userId: "svc-1" };

const BASE_TIME = Date.parse("2026-11-20T12:00:00.000Z");

function makeRecord(overrides: Partial<OperationRecord> & { id: string }): OperationRecord {
  return {
    kind: "ticket.redeem",
    state: "failed",
    correlationId: `corr-${overrides.id}`,
    createdAt: new Date(BASE_TIME - 60_000).toISOString(),
    updatedAt: new Date(BASE_TIME - 30_000).toISOString(),
    steps: [
      {
        id: "issue",
        status: "succeeded",
        attempt: 1,
        idempotencyKey: `operation:${overrides.id}:step:issue`,
        sideEffectCommitted: true,
        updatedAt: new Date(BASE_TIME - 50_000).toISOString()
      },
      {
        id: "transfer",
        status: "failed",
        attempt: 1,
        idempotencyKey: `operation:${overrides.id}:step:transfer`,
        sideEffectCommitted: false,
        errorCode: "horizon_timeout",
        updatedAt: new Date(BASE_TIME - 30_000).toISOString()
      }
    ],
    lastErrorCode: "horizon_timeout",
    ...overrides
  };
}

describe("operator-dashboard: normal paths", () => {
  it("returns an empty snapshot when storage has no operations", () => {
    const storage = createOperationStorage();
    const res = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;

    expect(res.value.totalOperations).toBe(0);
    expect(res.value.unresolvedCount).toBe(0);
    expect(res.value.items).toEqual([]);
    expect(res.value.truncated).toBe(false);
    expect(res.value.countsByCategory).toEqual({
      rollback_failed: 0,
      ambiguous_side_effect: 0,
      retryable_step_failure: 0,
      in_progress_stalled: 0
    });
    expect(res.value.countsBySeverity).toEqual({
      critical: 0,
      high: 0,
      medium: 0
    });
  });

  it("excludes completed and abandoned operations and classifies unresolved partial failures", () => {
    const completed = makeRecord({
      id: "op-completed",
      state: "completed",
      steps: [
        {
          id: "issue",
          status: "succeeded",
          attempt: 1,
          idempotencyKey: "k1",
          sideEffectCommitted: true,
          updatedAt: new Date(BASE_TIME - 10_000).toISOString()
        }
      ]
    });
    const abandoned = makeRecord({
      id: "op-abandoned",
      state: "abandoned"
    });
    const retryable = makeRecord({
      id: "op-retryable",
      state: "failed",
      updatedAt: new Date(BASE_TIME - 120_000).toISOString()
    });
    const ambiguous = makeRecord({
      id: "op-ambiguous",
      state: "interrupted",
      updatedAt: new Date(BASE_TIME - 60_000).toISOString(),
      steps: [
        {
          id: "issue",
          status: "succeeded",
          attempt: 1,
          idempotencyKey: "operation:op-ambiguous:step:issue",
          sideEffectCommitted: true,
          updatedAt: new Date(BASE_TIME - 90_000).toISOString()
        },
        {
          id: "transfer",
          status: "interrupted",
          attempt: 1,
          idempotencyKey: "operation:op-ambiguous:step:transfer",
          sideEffectCommitted: true,
          errorCode: "confirmation_timeout",
          updatedAt: new Date(BASE_TIME - 60_000).toISOString()
        }
      ]
    });
    const rollbackFailed = makeRecord({
      id: "op-rollback-failed",
      state: "interrupted",
      updatedAt: new Date(BASE_TIME - 10_000).toISOString(),
      steps: [
        {
          id: "issue",
          status: "succeeded",
          attempt: 1,
          idempotencyKey: "operation:op-rollback-failed:step:issue",
          sideEffectCommitted: true,
          rollbackStatus: "rollback_failed",
          rollbackErrorCode: "refund_rejected",
          updatedAt: new Date(BASE_TIME - 10_000).toISOString()
        }
      ]
    });
    const stalled = makeRecord({
      id: "op-stalled",
      state: "running",
      updatedAt: new Date(BASE_TIME - 300_000).toISOString(),
      steps: [
        {
          id: "issue",
          status: "succeeded",
          attempt: 1,
          idempotencyKey: "operation:op-stalled:step:issue",
          sideEffectCommitted: true,
          updatedAt: new Date(BASE_TIME - 310_000).toISOString()
        },
        {
          id: "transfer",
          status: "pending",
          attempt: 0,
          idempotencyKey: "operation:op-stalled:step:transfer",
          sideEffectCommitted: false,
          updatedAt: new Date(BASE_TIME - 300_000).toISOString()
        }
      ],
      lastErrorCode: undefined
    });

    expect(isUnresolvedPartialFailure(completed)).toBe(false);
    expect(isUnresolvedPartialFailure(abandoned)).toBe(false);
    expect(classifyPartialFailure(rollbackFailed)).toEqual({
      category: "rollback_failed",
      severity: "critical"
    });
    expect(classifyPartialFailure(ambiguous)).toEqual({
      category: "ambiguous_side_effect",
      severity: "high"
    });
    expect(classifyPartialFailure(retryable)).toEqual({
      category: "retryable_step_failure",
      severity: "medium"
    });
    expect(classifyPartialFailure(stalled)).toEqual({
      category: "in_progress_stalled",
      severity: "medium"
    });

    const storage = createOperationStorage([
      completed,
      abandoned,
      retryable,
      ambiguous,
      rollbackFailed,
      stalled
    ]);
    const res = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;

    expect(res.value.totalOperations).toBe(6);
    expect(res.value.unresolvedCount).toBe(4);
    // Deterministic ordering: critical -> high -> medium (oldest first within same severity)
    expect(res.value.items.map((item) => item.operationId)).toEqual([
      "op-rollback-failed",
      "op-ambiguous",
      "op-stalled",
      "op-retryable"
    ]);
    expect(res.value.countsByCategory).toEqual({
      rollback_failed: 1,
      ambiguous_side_effect: 1,
      retryable_step_failure: 1,
      in_progress_stalled: 1
    });
    expect(res.value.countsBySeverity).toEqual({
      critical: 1,
      high: 1,
      medium: 2
    });
    expect(res.value.items[0].lastErrorCode).toBe("refund_rejected");
    expect(res.value.items[1].allowedActions).toContain("confirm_applied");
    expect(res.value.items[1].allowedActions).toContain("confirm_not_applied");
    expect(res.value.items[1].allowedActions).not.toContain("retry");
  });

  it("supports filtering by kind, category, severity, minAgeMs, and limit", () => {
    const storage = createOperationStorage([
      makeRecord({ id: "op-1", kind: "ticket.redeem", updatedAt: new Date(BASE_TIME - 60_000).toISOString() }),
      makeRecord({ id: "op-2", kind: "webhook.deliver", updatedAt: new Date(BASE_TIME - 120_000).toISOString() }),
      makeRecord({ id: "op-3", kind: "ticket.redeem", updatedAt: new Date(BASE_TIME - 180_000).toISOString() })
    ]);

    const byKind = getOperatorDashboard(MAINTAINER, storage, {
      now: () => BASE_TIME,
      filter: { kind: "ticket.redeem", minAgeMs: 90_000 }
    });
    expect(isOk(byKind)).toBe(true);
    if (isOk(byKind)) {
      expect(byKind.value.items.map((i) => i.operationId)).toEqual(["op-3"]);
      expect(byKind.value.unresolvedCount).toBe(3);
      expect(byKind.value.truncated).toBe(false);
    }

    const limited = getOperatorDashboard(MAINTAINER, storage, {
      now: () => BASE_TIME,
      filter: { limit: 1 }
    });
    expect(isOk(limited)).toBe(true);
    if (isOk(limited)) {
      expect(limited.value.items.map((i) => i.operationId)).toEqual(["op-3"]);
      expect(limited.value.truncated).toBe(true);
    }
  });
});

describe("operator-dashboard: retry, confirmation, rollback, and abandon paths", () => {
  it("retries a retryable partial failure reusing the same idempotency key and clears it from the dashboard", async () => {
    const seenKeys: string[] = [];
    let shouldFail = true;

    const definition: OperationDefinition<{ amount: number }> = {
      kind: "ticket.redeem",
      steps: [
        {
          id: "issue",
          run: () => ({ status: "succeeded", output: { ticketId: "t-1" } })
        },
        {
          id: "transfer",
          run: ({ idempotencyKey }) => {
            seenKeys.push(idempotencyKey);
            if (shouldFail) {
              shouldFail = false;
              return { status: "failed", errorCode: "horizon_timeout", sideEffectCommitted: false };
            }
            return { status: "succeeded", output: { txHash: "abc123" } };
          }
        }
      ]
    };

    const storage = createOperationStorage();
    const initial = await runOperation(definition, {
      operationId: "op-retry-1",
      storage,
      context: { amount: 10 },
      now: () => BASE_TIME - 60_000
    });
    expect(isOk(initial)).toBe(true);

    // Appears on dashboard as retryable_step_failure
    const before = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });
    expect(isOk(before)).toBe(true);
    if (isOk(before)) {
      expect(before.value.unresolvedCount).toBe(1);
      expect(before.value.items[0].category).toBe("retryable_step_failure");
    }

    // Operator retries via dashboard action
    const retried = await executeOperatorAction(MAINTAINER, {
      action: "retry",
      definition,
      options: {
        operationId: "op-retry-1",
        storage,
        context: { amount: 10 },
        now: () => BASE_TIME
      }
    });
    expect(isOk(retried)).toBe(true);
    if (isOk(retried)) {
      expect(retried.value.record.state).toBe("completed");
      expect(retried.value.previousState).toBe("failed");
      expect(retried.value.auditActor).toBe("maintainer:ops-1");
    }
    expect(seenKeys).toEqual([
      "operation:op-retry-1:step:transfer",
      "operation:op-retry-1:step:transfer"
    ]);

    // Cleared from dashboard
    const after = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });
    expect(isOk(after)).toBe(true);
    if (isOk(after)) {
      expect(after.value.unresolvedCount).toBe(0);
    }
  });

  it("blocks retry on ambiguous side effects until operator confirms outcome, then completes", async () => {
    const transferRun = vi.fn(() => ({ status: "succeeded" as const, output: { ok: true } }));
    const definition: OperationDefinition<Record<string, never>> = {
      kind: "ticket.redeem",
      steps: [
        { id: "issue", run: () => ({ status: "succeeded" }) },
        { id: "transfer", run: transferRun }
      ]
    };

    const storage = createOperationStorage([
      makeRecord({
        id: "op-ambig-1",
        state: "interrupted",
        steps: [
          {
            id: "issue",
            status: "succeeded",
            attempt: 1,
            idempotencyKey: "operation:op-ambig-1:step:issue",
            sideEffectCommitted: true,
            updatedAt: new Date(BASE_TIME - 60_000).toISOString()
          },
          {
            id: "transfer",
            status: "interrupted",
            attempt: 1,
            idempotencyKey: "operation:op-ambig-1:step:transfer",
            sideEffectCommitted: true,
            errorCode: "confirmation_timeout",
            updatedAt: new Date(BASE_TIME - 30_000).toISOString()
          }
        ]
      })
    ]);

    // Direct retry must be blocked to prevent double-applying side effect
    const blocked = await executeOperatorAction(MAINTAINER, {
      action: "retry",
      definition,
      options: { operationId: "op-ambig-1", storage, context: {}, now: () => BASE_TIME }
    });
    expect(isErr(blocked)).toBe(true);
    if (isErr(blocked)) {
      expect(blocked.code).toBe("confirmation_required");
    }
    expect(transferRun).not.toHaveBeenCalled();

    // Operator confirms external side effect WAS applied
    const confirmed = await executeOperatorAction(MAINTAINER, {
      action: "confirm_applied",
      operationId: "op-ambig-1",
      stepId: "transfer",
      options: { storage, now: () => BASE_TIME }
    });
    expect(isOk(confirmed)).toBe(true);

    // Now retry closes out the operation WITHOUT re-running transfer
    const closed = await executeOperatorAction(MAINTAINER, {
      action: "retry",
      definition,
      options: { operationId: "op-ambig-1", storage, context: {}, now: () => BASE_TIME }
    });
    expect(isOk(closed)).toBe(true);
    if (isOk(closed)) {
      expect(closed.value.record.state).toBe("completed");
    }
    expect(transferRun).not.toHaveBeenCalled();
  });

  it("supports confirm_not_applied followed by retry", async () => {
    const transferRun = vi.fn(() => ({ status: "succeeded" as const }));
    const definition: OperationDefinition<Record<string, never>> = {
      kind: "ticket.redeem",
      steps: [
        { id: "issue", run: () => ({ status: "succeeded" }) },
        { id: "transfer", run: transferRun }
      ]
    };

    const storage = createOperationStorage([
      makeRecord({
        id: "op-ambig-2",
        state: "interrupted",
        steps: [
          {
            id: "issue",
            status: "succeeded",
            attempt: 1,
            idempotencyKey: "operation:op-ambig-2:step:issue",
            sideEffectCommitted: true,
            updatedAt: new Date(BASE_TIME - 60_000).toISOString()
          },
          {
            id: "transfer",
            status: "interrupted",
            attempt: 1,
            idempotencyKey: "operation:op-ambig-2:step:transfer",
            sideEffectCommitted: true,
            errorCode: "confirmation_timeout",
            updatedAt: new Date(BASE_TIME - 30_000).toISOString()
          }
        ]
      })
    ]);

    const confirmed = await executeOperatorAction(MAINTAINER, {
      action: "confirm_not_applied",
      operationId: "op-ambig-2",
      stepId: "transfer",
      options: { storage, now: () => BASE_TIME }
    });
    expect(isOk(confirmed)).toBe(true);

    const retried = await executeOperatorAction(MAINTAINER, {
      action: "retry",
      definition,
      options: { operationId: "op-ambig-2", storage, context: {}, now: () => BASE_TIME }
    });
    expect(isOk(retried)).toBe(true);
    expect(transferRun).toHaveBeenCalledTimes(1);
  });

  it("rolls back committed steps in LIFO order and surfaces rollback failures as critical", async () => {
    let failRollback = true;
    const rollbackOrder: string[] = [];

    const definition: OperationDefinition<Record<string, never>> = {
      kind: "ticket.redeem",
      steps: [
        {
          id: "issue",
          run: () => ({ status: "succeeded" }),
          rollback: () => {
            rollbackOrder.push("issue");
            if (failRollback) {
              failRollback = false;
              return { status: "failed", errorCode: "refund_timeout" };
            }
            return { status: "rolled_back" };
          }
        },
        {
          id: "transfer",
          run: () => ({ status: "failed", errorCode: "network_error", sideEffectCommitted: false })
        }
      ]
    };

    const storage = createOperationStorage([
      makeRecord({ id: "op-rb-1", state: "interrupted" })
    ]);

    // First rollback attempt fails -> surfaced as critical rollback_failed
    const firstRollback = await executeOperatorAction(MAINTAINER, {
      action: "rollback",
      definition,
      options: { operationId: "op-rb-1", storage, context: {}, now: () => BASE_TIME },
      failureReason: "operator_requested"
    });
    expect(isErr(firstRollback)).toBe(true);
    if (isErr(firstRollback)) {
      expect(firstRollback.code).toBe("rollback_failed");
    }

    const midDashboard = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });
    expect(isOk(midDashboard)).toBe(true);
    if (isOk(midDashboard)) {
      expect(midDashboard.value.items[0].category).toBe("rollback_failed");
      expect(midDashboard.value.items[0].severity).toBe("critical");
    }

    // Second rollback attempt succeeds -> operation is abandoned and cleared
    const secondRollback = await executeOperatorAction(MAINTAINER, {
      action: "rollback",
      definition,
      options: { operationId: "op-rb-1", storage, context: {}, now: () => BASE_TIME }
    });
    expect(isOk(secondRollback)).toBe(true);
    expect(rollbackOrder).toEqual(["issue", "issue"]);

    const finalDashboard = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });
    expect(isOk(finalDashboard)).toBe(true);
    if (isOk(finalDashboard)) {
      expect(finalDashboard.value.unresolvedCount).toBe(0);
    }
  });

  it("abandons an unresolved operation and removes it from the dashboard", async () => {
    const storage = createOperationStorage([makeRecord({ id: "op-abandon-1" })]);

    const res = await executeOperatorAction(MAINTAINER, {
      action: "abandon",
      operationId: "op-abandon-1",
      options: { storage, reason: "duplicate_request", now: () => BASE_TIME }
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.record.state).toBe("abandoned");
    }

    const dashboard = getOperatorDashboard(MAINTAINER, storage, { now: () => BASE_TIME });
    expect(isOk(dashboard)).toBe(true);
    if (isOk(dashboard)) {
      expect(dashboard.value.unresolvedCount).toBe(0);
    }
  });
});

describe("operator-dashboard: failure & authorization paths", () => {
  it("returns storage_error when storage.list() or storage.read() throws", async () => {
    const brokenStorage: OperationStorage = {
      read: () => {
        throw new Error("disk_io_error");
      },
      write: () => {
        throw new Error("disk_io_error");
      },
      remove: () => {
        throw new Error("disk_io_error");
      },
      list: () => {
        throw new Error("disk_io_error");
      }
    };

    const dashRes = getOperatorDashboard(MAINTAINER, brokenStorage);
    expect(isErr(dashRes)).toBe(true);
    if (isErr(dashRes)) expect(dashRes.code).toBe("storage_error");

    const actionRes = await executeOperatorAction(MAINTAINER, {
      action: "abandon",
      operationId: "op-1",
      options: { storage: brokenStorage }
    });
    expect(isErr(actionRes)).toBe(true);
    if (isErr(actionRes)) expect(actionRes.code).toBe("storage_error");
  });

  it("returns unknown_operation and already_terminal for invalid targets", async () => {
    const storage = createOperationStorage([
      makeRecord({ id: "op-done", state: "completed" })
    ]);
    const definition: OperationDefinition<Record<string, never>> = {
      kind: "ticket.redeem",
      steps: [{ id: "issue", run: () => ({ status: "succeeded" }) }]
    };

    const missing = await executeOperatorAction(MAINTAINER, {
      action: "abandon",
      operationId: "does-not-exist",
      options: { storage }
    });
    expect(isErr(missing)).toBe(true);
    if (isErr(missing)) expect(missing.code).toBe("unknown_operation");

    const terminal = await executeOperatorAction(MAINTAINER, {
      action: "retry",
      definition,
      options: { operationId: "op-done", storage, context: {} }
    });
    expect(isErr(terminal)).toBe(true);
    if (isErr(terminal)) expect(terminal.code).toBe("already_terminal");
  });

  it("denies viewer, service, and unrecognized roles for dashboard reads and all operator actions", async () => {
    const storage = createOperationStorage([makeRecord({ id: "op-auth-1" })]);
    const definition: OperationDefinition<Record<string, never>> = {
      kind: "ticket.redeem",
      steps: [{ id: "issue", run: () => ({ status: "succeeded" }) }]
    };

    const unauthorizedContexts: AuthContext[] = [
      VIEWER,
      SERVICE,
      { role: "unknown" as Role, userId: "intruder" }
    ];

    for (const auth of unauthorizedContexts) {
      const dashRes = getOperatorDashboard(auth, storage);
      expect(isErr(dashRes)).toBe(true);
      if (isErr(dashRes)) expect(dashRes.code).toBe("permission_denied");

      const retryRes = await executeOperatorAction(auth, {
        action: "retry",
        definition,
        options: { operationId: "op-auth-1", storage, context: {} }
      });
      expect(isErr(retryRes)).toBe(true);
      if (isErr(retryRes)) expect(retryRes.code).toBe("permission_denied");

      const confirmRes = await executeOperatorAction(auth, {
        action: "confirm_applied",
        operationId: "op-auth-1",
        stepId: "transfer",
        options: { storage }
      });
      expect(isErr(confirmRes)).toBe(true);
      if (isErr(confirmRes)) expect(confirmRes.code).toBe("permission_denied");

      const rollbackRes = await executeOperatorAction(auth, {
        action: "rollback",
        definition,
        options: { operationId: "op-auth-1", storage, context: {} }
      });
      expect(isErr(rollbackRes)).toBe(true);
      if (isErr(rollbackRes)) expect(rollbackRes.code).toBe("permission_denied");

      const abandonRes = await executeOperatorAction(auth, {
        action: "abandon",
        operationId: "op-auth-1",
        options: { storage }
      });
      expect(isErr(abandonRes)).toBe(true);
      if (isErr(abandonRes)) expect(abandonRes.code).toBe("permission_denied");
    }
  });
});
