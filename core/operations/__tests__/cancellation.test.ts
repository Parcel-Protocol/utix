import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import {
  createOperationCancellationManager,
  type OperationCancellationManager
} from "@/core/operations/cancellation";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-admin" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };
const OWNER: AuthContext = { role: "viewer", userId: "user-owner" };

describe("Cancellation and Cleanup for Long Operations (#437)", () => {
  describe("Normal path", () => {
    it("completes operation normally without triggering cancellation cleanup hooks", async () => {
      const manager = createOperationCancellationManager();
      const cleanupMock = vi.fn();

      const result = await manager.runOperationWithCancellation("op-normal-1", async (signal) => {
        manager.registerCleanup("op-normal-1", "release-escrow", cleanupMock);
        expect(signal.aborted).toBe(false);
        return { success: true };
      });

      expect(result).toEqual({ ok: true, value: { success: true } });
      expect(cleanupMock).not.toHaveBeenCalled();
    });

    it("cancels a running operation cooperatively and executes cleanup hooks in LIFO order", async () => {
      const manager = createOperationCancellationManager();
      const executionOrder: string[] = [];

      manager.registerOperation("op-cancel-1");
      manager.registerCleanup("op-cancel-1", "first-resource", () => {
        executionOrder.push("first-resource");
      });
      manager.registerCleanup("op-cancel-1", "second-resource", () => {
        executionOrder.push("second-resource");
      });
      manager.registerCleanup("op-cancel-1", "third-resource", () => {
        executionOrder.push("third-resource");
      });

      const cancelResult = await manager.cancelOperation("op-cancel-1", "Operator requested abort");

      expect(cancelResult.ok).toBe(true);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.status).toBe("cancelled");
      expect(cancelResult.value.idempotentReplay).toBe(false);

      // Strict LIFO execution order: third -> second -> first
      expect(executionOrder).toEqual(["third-resource", "second-resource", "first-resource"]);

      const report = manager.getReport("op-cancel-1");
      expect(report?.status).toBe("cancelled");
      expect(report?.cleanupSteps.every((s) => s.status === "succeeded")).toBe(true);
    });
  });

  describe("Failure path", () => {
    it("isolates cleanup failures and transitions operation to cleanup_failed", async () => {
      const manager = createOperationCancellationManager();
      const executionLog: string[] = [];

      manager.registerOperation("op-fail-1");
      manager.registerCleanup("op-fail-1", "cleanup-1", () => {
        executionLog.push("cleanup-1");
      });
      manager.registerCleanup("op-fail-1", "cleanup-flaky", () => {
        executionLog.push("cleanup-flaky");
        throw new Error("RPC network failure during rollback");
      });
      manager.registerCleanup("op-fail-1", "cleanup-3", () => {
        executionLog.push("cleanup-3");
      });

      const cancelResult = await manager.cancelOperation("op-fail-1", "Cancellation with failure");

      expect(cancelResult.ok).toBe(false);
      if (cancelResult.ok) return;
      expect(cancelResult.code).toBe("cleanup_failed");

      // All remaining hooks must execute despite cleanup-flaky failure
      expect(executionLog).toEqual(["cleanup-3", "cleanup-flaky", "cleanup-1"]);

      const report = manager.getReport("op-fail-1");
      expect(report?.status).toBe("cleanup_failed");
      const flakyStep = report?.cleanupSteps.find((s) => s.name === "cleanup-flaky");
      expect(flakyStep?.status).toBe("failed");
      expect(flakyStep?.lastError).toContain("RPC network failure");
    });

    it("rejects cancellation of unknown operations or completed operations", async () => {
      const manager = createOperationCancellationManager();

      const unknownResult = await manager.cancelOperation("non-existent-op", "Reason");
      expect(unknownResult).toEqual({ ok: false, code: "unknown_operation" });

      await manager.runOperationWithCancellation("op-completed", async () => "finished");
      const completedResult = await manager.cancelOperation("op-completed", "Reason");
      expect(completedResult).toEqual({ ok: false, code: "already_completed" });
    });
  });

  describe("Retry path", () => {
    it("idempotently returns existing report on repeated cancellation", async () => {
      const manager = createOperationCancellationManager();
      let cleanupCount = 0;

      manager.registerOperation("op-retry-1");
      manager.registerCleanup("op-retry-1", "single-cleanup", () => {
        cleanupCount++;
      });

      const first = await manager.cancelOperation("op-retry-1", "First abort");
      expect(first.ok).toBe(true);
      expect(cleanupCount).toBe(1);

      // Second cancellation should replay outcome without re-running hooks
      const second = await manager.cancelOperation("op-retry-1", "Second abort");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.idempotentReplay).toBe(true);
      expect(cleanupCount).toBe(1);
    });

    it("re-runs only failed cleanup hooks on retryOperationCleanup", async () => {
      const manager = createOperationCancellationManager();
      let step1Attempts = 0;
      let flakyAttempts = 0;
      let shouldFlakyPass = false;

      manager.registerOperation("op-retry-steps");
      manager.registerCleanup("op-retry-steps", "step-1", () => {
        step1Attempts++;
      });
      manager.registerCleanup("op-retry-steps", "step-flaky", () => {
        flakyAttempts++;
        if (!shouldFlakyPass) throw new Error("Transient error");
      });

      // Initial cancel fails
      const initial = await manager.cancelOperation("op-retry-steps", "Cancel");
      expect(initial.ok).toBe(false);
      expect(step1Attempts).toBe(1);
      expect(flakyAttempts).toBe(1);

      // Now heal failure and retry cleanup
      shouldFlakyPass = true;
      const retryResult = await manager.retryOperationCleanup("op-retry-steps");

      expect(retryResult.ok).toBe(true);
      if (!retryResult.ok) return;
      expect(retryResult.value.status).toBe("cancelled");
      // step-1 already succeeded, so it was skipped on retry
      expect(step1Attempts).toBe(1);
      expect(flakyAttempts).toBe(2);
    });
  });

  describe("Authorization path", () => {
    it("allows maintainers and owners to cancel operations", async () => {
      const manager = createOperationCancellationManager();
      manager.registerOperation("op-auth-maintainer", "user-different");
      manager.registerOperation("op-auth-owner", "user-owner");

      const maintainerCancel = await manager.cancelOperationAuthorized(
        MAINTAINER,
        { id: "op-auth-maintainer", ownerId: "user-different" },
        "Maintainer cancel"
      );
      expect(maintainerCancel.ok).toBe(true);

      const ownerCancel = await manager.cancelOperationAuthorized(
        OWNER,
        { id: "op-auth-owner", ownerId: "user-owner" },
        "Owner cancel"
      );
      expect(ownerCancel.ok).toBe(true);
    });

    it("rejects unauthorized actors with permission_denied", async () => {
      const manager = createOperationCancellationManager();
      manager.registerOperation("op-auth-restricted", "user-other");

      const viewerAttempt = await manager.cancelOperationAuthorized(
        VIEWER,
        { id: "op-auth-restricted", ownerId: "user-other" },
        "Viewer attempt"
      );
      expect(viewerAttempt).toEqual({ ok: false, code: "permission_denied" });

      const retryAttempt = await manager.retryOperationCleanupAuthorized(
        VIEWER,
        { id: "op-auth-restricted", ownerId: "user-other" }
      );
      expect(retryAttempt).toEqual({ ok: false, code: "permission_denied" });
    });
  });
});
