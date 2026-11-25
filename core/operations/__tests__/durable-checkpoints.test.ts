import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import {
  createMemoryDurableCheckpointStore,
  executeWithDurableCheckpoint,
  resolveInDoubtCheckpoint,
  resolveInDoubtCheckpointAuthorized
} from "@/core/operations";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-admin" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };

describe("Durable Checkpoints Around External Side Effects (#438)", () => {
  describe("Normal path", () => {
    it("writes pre-commit intent and post-commit receipt on successful side effect", async () => {
      const store = createMemoryDurableCheckpointStore();
      const mockAction = vi.fn().mockResolvedValue({
        output: { balance: "100.0000000" },
        externalReceipt: { transactionHash: "tx-hash-12345", externalId: "stellar-ledger-500" }
      });

      const result = await executeWithDurableCheckpoint({
        store,
        operationId: "op-settle-1",
        stepId: "transfer_asset",
        idempotencyKey: "idem-key-normal-1",
        payload: { to: "GBB...TEST", amount: 100 },
        action: mockAction
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.replayed).toBe(false);
      expect(result.value.output).toEqual({ balance: "100.0000000" });
      expect(result.value.checkpoint.phase).toBe("committed");
      expect(result.value.checkpoint.sideEffectCommitted).toBe(true);
      expect(result.value.checkpoint.externalReceipt?.transactionHash).toBe("tx-hash-12345");
      expect(mockAction).toHaveBeenCalledTimes(1);
    });
  });

  describe("Failure path", () => {
    it("handles definitive external failure and marks checkpoint failed without committing side effect", async () => {
      const store = createMemoryDurableCheckpointStore();
      const mockAction = vi.fn().mockRejectedValue(new Error("400 Bad Request: Invalid signature"));

      const result = await executeWithDurableCheckpoint({
        store,
        operationId: "op-settle-fail",
        stepId: "transfer_asset",
        idempotencyKey: "idem-key-fail-1",
        payload: { to: "GBB...TEST" },
        action: mockAction,
        isDefinitiveFailure: (e) => String(e).includes("400 Bad Request")
      });

      expect(result).toEqual({ ok: false, code: "external_effect_failed" });

      const checkpoint = store.byKey("idem-key-fail-1");
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.phase).toBe("failed");
      expect(checkpoint?.sideEffectCommitted).toBe(false);
      expect(checkpoint?.errorCode).toBe("definitive_failure");
    });

    it("marks checkpoint as in_doubt on ambiguous network error/timeout and halts automatic retries", async () => {
      const store = createMemoryDurableCheckpointStore();
      const mockAction = vi.fn().mockRejectedValue(new Error("Connection reset / Gateway timeout 504"));

      const result = await executeWithDurableCheckpoint({
        store,
        operationId: "op-settle-timeout",
        stepId: "submit_payment",
        idempotencyKey: "idem-key-timeout-1",
        payload: { tx: "0xdeadbeef" },
        action: mockAction,
        isDefinitiveFailure: () => false // Ambiguous timeout
      });

      expect(result).toEqual({ ok: false, code: "external_effect_in_doubt" });

      const checkpoint = store.byKey("idem-key-timeout-1");
      expect(checkpoint?.phase).toBe("in_doubt");
      expect(checkpoint?.sideEffectCommitted).toBe(true); // Prevents blind re-application

      // Subsequent attempt must be blocked as in_doubt
      const immediateRetry = await executeWithDurableCheckpoint({
        store,
        operationId: "op-settle-timeout",
        stepId: "submit_payment",
        idempotencyKey: "idem-key-timeout-1",
        payload: { tx: "0xdeadbeef" },
        action: mockAction
      });
      expect(immediateRetry).toEqual({ ok: false, code: "external_effect_in_doubt" });
      expect(mockAction).toHaveBeenCalledTimes(1); // Did not re-execute action!
    });
  });

  describe("Retry path", () => {
    it("returns committed outcome idempotently without re-invoking external action", async () => {
      const store = createMemoryDurableCheckpointStore();
      let callCount = 0;
      const mockAction = vi.fn().mockImplementation(async () => {
        callCount++;
        return { output: { receiptNumber: 999 }, externalReceipt: { transactionHash: "hash-999" } };
      });

      const first = await executeWithDurableCheckpoint({
        store,
        operationId: "op-replay-1",
        stepId: "step-1",
        idempotencyKey: "idem-key-replay-1",
        payload: { data: "abc" },
        action: mockAction
      });
      expect(first.ok).toBe(true);
      expect(callCount).toBe(1);

      const second = await executeWithDurableCheckpoint({
        store,
        operationId: "op-replay-1",
        stepId: "step-1",
        idempotencyKey: "idem-key-replay-1",
        payload: { data: "abc" },
        action: mockAction
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.replayed).toBe(true);
      expect(second.value.output).toEqual({ receiptNumber: 999 });
      expect(callCount).toBe(1); // Action NOT invoked again!
    });

    it("allows retry of failed side effect and increments attempt counter", async () => {
      const store = createMemoryDurableCheckpointStore();
      let attempt = 0;
      const mockAction = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) throw new Error("400 Bad Request");
        return { output: { confirmed: true } };
      });

      const first = await executeWithDurableCheckpoint({
        store,
        operationId: "op-retry-fail",
        stepId: "step-1",
        idempotencyKey: "idem-key-retry-fail",
        payload: { data: "test" },
        action: mockAction,
        isDefinitiveFailure: () => true
      });
      expect(first.ok).toBe(false);

      const second = await executeWithDurableCheckpoint({
        store,
        operationId: "op-retry-fail",
        stepId: "step-1",
        idempotencyKey: "idem-key-retry-fail",
        payload: { data: "test" },
        action: mockAction
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.checkpoint.attempt).toBe(2);
      expect(second.value.checkpoint.phase).toBe("committed");
    });
  });

  describe("Authorization path", () => {
    it("allows maintainer to resolve in-doubt checkpoint after out-of-band verification", async () => {
      const store = createMemoryDurableCheckpointStore();

      // Setup an in-doubt checkpoint
      await executeWithDurableCheckpoint({
        store,
        operationId: "op-auth-resolve",
        stepId: "submit_payment",
        idempotencyKey: "idem-key-in-doubt",
        payload: {},
        action: async () => { throw new Error("Network timeout"); },
        isDefinitiveFailure: () => false
      });

      const cp = store.byKey("idem-key-in-doubt")!;
      expect(cp.phase).toBe("in_doubt");

      // Maintainer resolves it as applied
      const resolved = resolveInDoubtCheckpointAuthorized(MAINTAINER, store, cp.id, {
        outcome: "applied",
        externalReceipt: { transactionHash: "recovered-tx-hash-777" },
        output: { status: "settled_manually" },
        reason: "Confirmed on Stellar Horizon explorer"
      });

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.phase).toBe("committed");
      expect(resolved.value.sideEffectCommitted).toBe(true);
      expect(resolved.value.externalReceipt?.transactionHash).toBe("recovered-tx-hash-777");
    });

    it("rejects unauthorized actors attempting to resolve in-doubt checkpoint", async () => {
      const store = createMemoryDurableCheckpointStore();

      await executeWithDurableCheckpoint({
        store,
        operationId: "op-unauth",
        stepId: "step-1",
        idempotencyKey: "idem-key-unauth",
        payload: {},
        action: async () => { throw new Error("Timeout"); },
        isDefinitiveFailure: () => false
      });

      const cp = store.byKey("idem-key-unauth")!;

      const viewerAttempt = resolveInDoubtCheckpointAuthorized(VIEWER, store, cp.id, {
        outcome: "applied",
        reason: "Viewer attempt"
      });

      expect(viewerAttempt).toEqual({ ok: false, code: "permission_denied" });
    });
  });
});
