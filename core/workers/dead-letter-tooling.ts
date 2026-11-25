/**
 * Maintainer-only, read-only inspection and explicitly confirmed recovery.
 * Delegates execution to WorkerFramework.recoverDeadLetter so original dead
 * letters remain terminal and duplicate requests are idempotent.
 */
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry } from "@/core/telemetry/telemetry";
import {
  DEAD_LETTER_RECOVERY_PERMISSION,
  type WorkerFramework,
  type RecoverDeadLetterOptions
} from "@/core/workers/queue";

export type DeadLetterToolError =
  | "unauthorized"
  | "unknown_job"
  | "not_dead_lettered"
  | "unregistered"
  | "confirmation_required";

export interface DeadLetterSummary {
  id: string;
  operation: string;
  attempts: number;
  maxAttempts: number;
  errorCode?: string;
  correlationId: string;
  recoveredBy?: string;
  checkpointAvailable: boolean;
}

function canRecover(auth: AuthContext): boolean {
  return hasPermission(auth.role, DEAD_LETTER_RECOVERY_PERMISSION);
}

export function inspectDeadLetters(
  worker: WorkerFramework,
  auth: AuthContext
): Result<readonly DeadLetterSummary[], "unauthorized"> {
  if (!canRecover(auth)) return err("unauthorized");
  return ok(worker.inspect("dead_lettered").map((job) => ({
    id: job.id,
    operation: job.operation,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorCode: job.lastError?.code,
    correlationId: job.correlationId,
    recoveredBy: job.recoveredBy,
    checkpointAvailable: job.checkpoint !== undefined
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

export interface ConfirmedRecoveryOptions extends RecoverDeadLetterOptions {
  /** Must match the dead letter id; prevents an accidental replay. */
  confirm: string;
}

export function retryDeadLetter(
  worker: WorkerFramework,
  auth: AuthContext,
  id: string,
  options: ConfirmedRecoveryOptions
): Result<{ original: string; replacement: string; correlationId: string }, DeadLetterToolError> {
  if (!canRecover(auth)) return err("unauthorized");
  if (!id || options.confirm !== id) return err("confirmation_required");
  const recovered = worker.recoverDeadLetter(id, auth, { resume: options.resume });
  if (!recovered.ok) return recovered;
  emitTelemetry({
    op: "worker.dead_letter_retry_requested",
    actorType: "user",
    correlationId: recovered.value.correlationId,
    payload: { original: id, replacement: recovered.value.id, resume: options.resume !== false }
  });
  return ok({
    original: id,
    replacement: recovered.value.id,
    correlationId: recovered.value.correlationId
  });
}
