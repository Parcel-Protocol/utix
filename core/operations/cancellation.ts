/**
 * Safe cancellation and deterministic LIFO cleanup for long-running operations (#437).
 *
 * Provides targeted, authorization-enforced cancellation, AbortSignal propagation,
 * and deterministic LIFO resource cleanup for multi-step operations.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, isErr, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import type { OperationRecord, OperationStorage } from "@/core/operations/types";

export type OperationCancellationStatus =
  | "running"
  | "cancelling"
  | "cancelled"
  | "cleanup_failed"
  | "completed"
  | "failed";

export type OperationCleanupStepStatus = "pending" | "succeeded" | "failed";

export interface OperationCleanupStep {
  readonly id: string;
  readonly name: string;
  status: OperationCleanupStepStatus;
  attempts: number;
  lastError?: string;
  completedAt?: string;
}

export interface OperationCancellationReport {
  readonly operationId: string;
  readonly status: OperationCancellationStatus;
  readonly cancelledAt: string;
  readonly reason: string;
  readonly cleanupSteps: readonly OperationCleanupStep[];
  readonly forced: boolean;
  readonly idempotentReplay: boolean;
}

export type OperationCancellationErrorCode =
  | "permission_denied"
  | "unknown_operation"
  | "already_completed"
  | "already_failed"
  | "cleanup_failed"
  | "not_cleanup_failed";

export type OperationCleanupHandler = (operationId: string) => Promise<void> | void;

interface RegisteredCleanupHook {
  readonly id: string;
  readonly name: string;
  readonly handler: OperationCleanupHandler;
  status: OperationCleanupStepStatus;
  attempts: number;
  lastError?: string;
  completedAt?: string;
}

interface ActiveOperationEntry {
  readonly operationId: string;
  readonly ownerId?: string;
  status: OperationCancellationStatus;
  readonly controller: AbortController;
  readonly cleanupHooks: RegisteredCleanupHook[];
  forced: boolean;
  reason?: string;
  cancelledAt?: string;
  inFlightCancellation?: Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>>;
}

export interface OperationCancellationOptions {
  readonly gracePeriodMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_GRACE_PERIOD_MS = 1_500;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;

export interface OperationCancellationManager {
  readonly registerOperation: (operationId: string, ownerId?: string) => AbortSignal;
  readonly registerCleanup: (operationId: string, name: string, handler: OperationCleanupHandler) => string;
  readonly runOperationWithCancellation: <T>(
    operationId: string,
    runner: (signal: AbortSignal) => Promise<T>
  ) => Promise<Result<T, "operation_cancelled" | "operation_failed">>;
  readonly cancelOperation: (
    operationId: string,
    reason: string,
    options?: OperationCancellationOptions
  ) => Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>>;
  readonly cancelOperationAuthorized: (
    auth: AuthContext,
    operation: { id: string; ownerId?: string },
    reason: string,
    options?: OperationCancellationOptions
  ) => Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>>;
  readonly retryOperationCleanup: (
    operationId: string,
    options?: OperationCancellationOptions
  ) => Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>>;
  readonly retryOperationCleanupAuthorized: (
    auth: AuthContext,
    operation: { id: string; ownerId?: string },
    options?: OperationCancellationOptions
  ) => Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>>;
  readonly getReport: (operationId: string) => OperationCancellationReport | undefined;
}

function timeoutPromise(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOperationCancellationManager(): OperationCancellationManager {
  const operations = new Map<string, ActiveOperationEntry>();

  const registerOperation = (operationId: string, ownerId?: string): AbortSignal => {
    const existing = operations.get(operationId);
    if (existing) return existing.controller.signal;

    const controller = new AbortController();
    const entry: ActiveOperationEntry = {
      operationId,
      ownerId,
      status: "running",
      controller,
      cleanupHooks: [],
      forced: false
    };
    operations.set(operationId, entry);
    return controller.signal;
  };

  const registerCleanup = (
    operationId: string,
    name: string,
    handler: OperationCleanupHandler
  ): string => {
    let entry = operations.get(operationId);
    if (!entry) {
      registerOperation(operationId);
      entry = operations.get(operationId)!;
    }
    const hookId = `cleanup-${entry.cleanupHooks.length + 1}-${name}`;
    entry.cleanupHooks.push({
      id: hookId,
      name,
      handler,
      status: "pending",
      attempts: 0
    });
    return hookId;
  };

  const runOperationWithCancellation = async <T>(
    operationId: string,
    runner: (signal: AbortSignal) => Promise<T>
  ): Promise<Result<T, "operation_cancelled" | "operation_failed">> => {
    let entry = operations.get(operationId);
    if (!entry) {
      registerOperation(operationId);
      entry = operations.get(operationId)!;
    }

    try {
      const result = await runner(entry.controller.signal);
      if (entry.status === "running") {
        entry.status = "completed";
      }
      return ok(result);
    } catch (error) {
      if (entry.controller.signal.aborted || entry.status === "cancelled" || entry.status === "cancelling") {
        return err("operation_cancelled");
      }
      entry.status = "failed";
      return err("operation_failed");
    }
  };

  const executeCleanupLIFO = async (
    entry: ActiveOperationEntry,
    options?: OperationCancellationOptions
  ): Promise<boolean> => {
    const timeoutMs = options?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    const nowFn = options?.now ?? (() => Date.now());
    let allSucceeded = true;

    // Execute in reverse registration order (LIFO)
    const reversedHooks = [...entry.cleanupHooks].reverse();

    for (const hook of reversedHooks) {
      if (hook.status === "succeeded") {
        continue; // Skip already completed hooks on retry
      }

      hook.attempts++;
      try {
        await Promise.race([
          Promise.resolve(hook.handler(entry.operationId)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Cleanup hook "${hook.name}" timed out after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
        hook.status = "succeeded";
        hook.completedAt = new Date(nowFn()).toISOString();
        hook.lastError = undefined;
      } catch (err) {
        allSucceeded = false;
        hook.status = "failed";
        hook.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return allSucceeded;
  };

  const cancelOperation = async (
    operationId: string,
    reason: string,
    options?: OperationCancellationOptions
  ): Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>> => {
    const entry = operations.get(operationId);
    if (!entry) return err("unknown_operation");

    if (entry.status === "completed") return err("already_completed");
    if (entry.status === "failed") return err("already_failed");

    // Idempotent replay if already cancelled
    if (entry.status === "cancelled") {
      return ok(buildReport(entry, true));
    }

    if (entry.inFlightCancellation) {
      return entry.inFlightCancellation;
    }

    const runCancellation = async (): Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>> => {
      const nowFn = options?.now ?? (() => Date.now());
      entry.status = "cancelling";
      entry.reason = reason;
      entry.cancelledAt = new Date(nowFn()).toISOString();

      // Trigger abort signal
      entry.controller.abort();

      const graceMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
      await timeoutPromise(Math.min(graceMs, 20));

      const cleanupsOk = await executeCleanupLIFO(entry, options);
      if (cleanupsOk) {
        entry.status = "cancelled";
        return ok(buildReport(entry, false));
      } else {
        entry.status = "cleanup_failed";
        return err("cleanup_failed");
      }
    };

    entry.inFlightCancellation = runCancellation().finally(() => {
      entry.inFlightCancellation = undefined;
    });

    return entry.inFlightCancellation;
  };

  const cancelOperationAuthorized = async (
    auth: AuthContext,
    operation: { id: string; ownerId?: string },
    reason: string,
    options?: OperationCancellationOptions
  ): Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>> => {
    const isMaintainer = hasPermission(auth.role, "admin:recovery") || auth.role === "maintainer";
    const isOwner = Boolean(operation.ownerId && auth.userId === operation.ownerId);

    if (!isMaintainer && !isOwner) {
      return err("permission_denied");
    }

    return cancelOperation(operation.id, reason, options);
  };

  const retryOperationCleanup = async (
    operationId: string,
    options?: OperationCancellationOptions
  ): Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>> => {
    const entry = operations.get(operationId);
    if (!entry) return err("unknown_operation");

    if (entry.status !== "cleanup_failed") {
      return err("not_cleanup_failed");
    }

    const cleanupsOk = await executeCleanupLIFO(entry, options);
    if (cleanupsOk) {
      entry.status = "cancelled";
      return ok(buildReport(entry, false));
    } else {
      entry.status = "cleanup_failed";
      return err("cleanup_failed");
    }
  };

  const retryOperationCleanupAuthorized = async (
    auth: AuthContext,
    operation: { id: string; ownerId?: string },
    options?: OperationCancellationOptions
  ): Promise<Result<OperationCancellationReport, OperationCancellationErrorCode>> => {
    const isMaintainer = hasPermission(auth.role, "admin:recovery") || auth.role === "maintainer";
    const isOwner = Boolean(operation.ownerId && auth.userId === operation.ownerId);

    if (!isMaintainer && !isOwner) {
      return err("permission_denied");
    }

    return retryOperationCleanup(operation.id, options);
  };

  const getReport = (operationId: string): OperationCancellationReport | undefined => {
    const entry = operations.get(operationId);
    return entry ? buildReport(entry, false) : undefined;
  };

  const buildReport = (entry: ActiveOperationEntry, isReplay: boolean): OperationCancellationReport => ({
    operationId: entry.operationId,
    status: entry.status,
    cancelledAt: entry.cancelledAt ?? new Date().toISOString(),
    reason: entry.reason ?? "Operator cancellation",
    forced: entry.forced,
    idempotentReplay: isReplay,
    cleanupSteps: entry.cleanupHooks.map((hook) => ({
      id: hook.id,
      name: hook.name,
      status: hook.status,
      attempts: hook.attempts,
      lastError: hook.lastError,
      completedAt: hook.completedAt
    }))
  });

  return {
    registerOperation,
    registerCleanup,
    runOperationWithCancellation,
    cancelOperation,
    cancelOperationAuthorized,
    retryOperationCleanup,
    retryOperationCleanupAuthorized,
    getReport
  };
}
