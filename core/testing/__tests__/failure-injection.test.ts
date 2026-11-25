import { beforeEach, describe, expect, it } from "vitest";
import {
  FailureInjectionEngine,
  type FailureInjectionRule
} from "../failure-injection";
import type { OperationRecord, OperationStorage } from "@/core/operations/types";

describe("Issue #357: End-to-End Failure Injection for Critical Workflows", () => {
  let injector: FailureInjectionEngine;
  let mockTime: number;

  beforeEach(() => {
    mockTime = 1700000000000;
    injector = new FailureInjectionEngine({
      now: () => mockTime
    });
  });

  describe("Normal Path", () => {
    it("executes operations without interference when no rules match", async () => {
      let executed = false;
      const result = await injector.wrapAsync("operation_recovery", "step_init", async () => {
        executed = true;
        return { success: true, count: 42 };
      });

      expect(executed).toBe(true);
      expect(result).toEqual({ success: true, count: 42 });
      expect(injector.getHistory().length).toBe(0);
    });

    it("bypasses fault injection when engine is disabled", async () => {
      injector.registerRule({
        id: "rule-disabled",
        workflow: "operation_recovery",
        targetStep: "step_commit",
        faultType: "http_error",
        enabled: true
      });

      injector.setEnabled(false);

      const result = await injector.wrapAsync("operation_recovery", "step_commit", async () => {
        return "clean_execution";
      });

      expect(result).toBe("clean_execution");
    });
  });

  describe("Failure Path", () => {
    it("injects simulated HTTP 429 rate limit error", async () => {
      injector.registerRule({
        id: "rule-rate-limit",
        workflow: "horizon_client",
        targetStep: "get_account",
        faultType: "http_error",
        faultConfig: {
          status: 429,
          message: "Horizon 429: Rate limit exceeded"
        },
        enabled: true
      });

      await expect(
        injector.wrapAsync("horizon_client", "get_account", async () => {
          return { id: "GAAAA" };
        })
      ).rejects.toThrow("Horizon 429: Rate limit exceeded");

      const history = injector.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].faultType).toBe("http_error");
    });

    it("injects simulated process crash / step interruption", async () => {
      injector.registerRule({
        id: "rule-crash",
        workflow: "multi_step_transfer",
        targetStep: "checkpoint_commit",
        faultType: "step_interruption",
        faultConfig: { message: "Process terminated unexpectedly" },
        enabled: true
      });

      await expect(
        injector.wrapAsync("multi_step_transfer", "checkpoint_commit", async () => {
          return "committed";
        })
      ).rejects.toThrow("Process terminated unexpectedly");
    });

    it("injects network timeout error with ETIMEDOUT code", async () => {
      injector.registerRule({
        id: "rule-timeout",
        workflow: "rpc_client",
        targetStep: "simulate_transaction",
        faultType: "network_timeout",
        enabled: true
      });

      try {
        await injector.wrapAsync("rpc_client", "simulate_transaction", async () => "ok");
        expect.unreachable("Must throw timeout");
      } catch (err: any) {
        expect(err.code).toBe("ETIMEDOUT");
      }
    });
  });

  describe("Retry Path", () => {
    it("fails on attempt 1 and recovers on retry (attempt 2)", async () => {
      // Simulate transient 503 error on first attempt only
      injector.registerRule({
        id: "rule-retry-test",
        workflow: "worker_queue",
        targetStep: "execute_job",
        faultType: "http_error",
        faultConfig: { status: 503, message: "503 Service Unavailable" },
        condition: {
          triggerAttempt: 1 // Only attempt 1 fails!
        },
        enabled: true
      });

      // Attempt 1: Injected Failure
      await expect(
        injector.wrapAsync("worker_queue", "execute_job", async () => "job_done")
      ).rejects.toThrow("503 Service Unavailable");

      // Attempt 2 (Retry): Succeeds cleanly
      const retryResult = await injector.wrapAsync("worker_queue", "execute_job", async () => "job_done");
      expect(retryResult).toBe("job_done");
    });
  });

  describe("Authorization Path", () => {
    it("rejects rule registration from unauthorized user role", () => {
      const rule: FailureInjectionRule = {
        id: "rule-unauth",
        workflow: "auth_service",
        targetStep: "validate_token",
        faultType: "http_error",
        enabled: true
      };

      const result = injector.registerRule(rule, {
        role: "viewer",
        userId: "viewer-1"
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("permission_denied");
    });

    it("allows rule registration from authorized maintainer", () => {
      const rule: FailureInjectionRule = {
        id: "rule-auth",
        workflow: "auth_service",
        targetStep: "validate_token",
        faultType: "http_error",
        enabled: true
      };

      const result = injector.registerRule(rule, {
        role: "maintainer",
        userId: "maintainer-admin"
      });

      expect(result.ok).toBe(true);
    });

    it("rejects rule unregistration from unauthorized user", () => {
      injector.registerRule({
        id: "rule-protected",
        workflow: "system",
        targetStep: "test",
        faultType: "http_error",
        enabled: true
      });

      const unregisterRes = injector.unregisterRule("rule-protected", {
        role: "viewer",
        userId: "attacker"
      });

      expect(unregisterRes).toBe(false);
    });
  });

  describe("Storage Wrapping & Rollback Resilience", () => {
    it("wraps operation storage to inject disk write failure and test rollback", () => {
      const inMemoryMap = new Map<string, OperationRecord>();
      const mockStorage: OperationStorage = {
        read: (id) => inMemoryMap.get(id),
        write: (record) => {
          inMemoryMap.set(record.id, record);
        },
        remove: (id) => {
          inMemoryMap.delete(id);
        },
        list: () => Array.from(inMemoryMap.values())
      };

      // Wrap storage
      const faultStorage = injector.wrapStorage(mockStorage, "recovery_flow");

      // Register write failure rule
      injector.registerRule({
        id: "rule-storage-write-fail",
        workflow: "recovery_flow",
        targetStep: "storage_write",
        faultType: "storage_fault",
        faultConfig: { message: "Disk full or storage connection closed" },
        enabled: true
      });

      const sampleRecord: OperationRecord = {
        id: "op-101",
        kind: "reconciliation_repair",
        state: "running",
        steps: [
          {
            id: "step_1",
            status: "running",
            attempt: 1,
            idempotencyKey: "op-101:step-1",
            sideEffectCommitted: false,
            updatedAt: new Date().toISOString()
          }
        ],
        correlationId: "corr-101",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      expect(() => {
        faultStorage.write(sampleRecord);
      }).toThrow("Disk full or storage connection closed");

      // Verify uncommitted state
      expect(inMemoryMap.has("op-101")).toBe(false);
    });
  });
});

