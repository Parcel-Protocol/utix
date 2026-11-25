/**
 * Operator dashboard for unresolved partial failures.
 *
 * Surfaces multi-step operations that stopped part-way — failed steps,
 * interrupted steps with ambiguous external side effects, failed rollbacks,
 * and stalled mid-flight operations — and exposes authorization-enforced
 * recovery actions (retry, confirm external outcome, rollback, abandon).
 *
 * Built directly on top of `core/operations` checkpoints and `core/auth`
 * permissions without modifying any existing operation or auth contracts.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { summarizeOperation, type OperationSummary } from "@/core/operations/diagnostics";
import {
  abandonOperationAuthorized,
  decideStep,
  nextActionFor,
  resolveInterruptedStepAuthorized,
  rollbackOperationAuthorized,
  runOperation,
  type ResolveOperationOptions
} from "@/core/operations/recovery";
import {
  TERMINAL_OPERATION_STATES,
  type OperationDefinition,
  type OperationErrorCode,
  type OperationRecord,
  type OperationState,
  type OperationStorage,
  type RecoveryAction,
  type RunOperationOptions
} from "@/core/operations/types";
import { err, isErr, ok, type Result } from "@/core/result/result";

export type PartialFailureCategory =
  | "rollback_failed"
  | "ambiguous_side_effect"
  | "retryable_step_failure"
  | "in_progress_stalled";

export type PartialFailureSeverity = "critical" | "high" | "medium";

export type OperatorActionKind =
  | "retry"
  | "confirm_applied"
  | "confirm_not_applied"
  | "rollback"
  | "abandon";

export type OperatorDashboardErrorCode =
  | OperationErrorCode
  | "confirmation_required"
  | "invalid_action";

export interface OperatorDashboardItem {
  readonly operationId: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly correlationId: string;
  readonly category: PartialFailureCategory;
  readonly severity: PartialFailureSeverity;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly failedStepId: string | null;
  readonly committedStepIds: readonly string[];
  readonly ageMs: number;
  readonly updatedAt: string;
  readonly lastErrorCode: string | null;
  readonly nextAction: RecoveryAction | null;
  readonly allowedActions: readonly OperatorActionKind[];
  readonly summary: OperationSummary;
}

export interface OperatorDashboardSnapshot {
  readonly generatedAt: string;
  readonly totalOperations: number;
  readonly unresolvedCount: number;
  readonly countsByCategory: Readonly<Record<PartialFailureCategory, number>>;
  readonly countsBySeverity: Readonly<Record<PartialFailureSeverity, number>>;
  readonly items: readonly OperatorDashboardItem[];
  readonly truncated: boolean;
}

export interface OperatorDashboardFilter {
  readonly kind?: string;
  readonly category?: PartialFailureCategory;
  readonly severity?: PartialFailureSeverity;
  readonly minAgeMs?: number;
  readonly limit?: number;
}

export interface OperatorDashboardOptions {
  readonly now?: () => number;
  readonly filter?: OperatorDashboardFilter;
}

export type OperatorActionRequest<TContext = unknown> =
  | {
      readonly action: "retry";
      readonly definition: OperationDefinition<TContext>;
      readonly options: RunOperationOptions<TContext>;
    }
  | {
      readonly action: "confirm_applied" | "confirm_not_applied";
      readonly operationId: string;
      readonly stepId: string;
      readonly options: ResolveOperationOptions;
    }
  | {
      readonly action: "rollback";
      readonly definition: OperationDefinition<TContext>;
      readonly options: RunOperationOptions<TContext>;
      readonly failureReason?: string;
    }
  | {
      readonly action: "abandon";
      readonly operationId: string;
      readonly options: ResolveOperationOptions;
    };

export interface OperatorActionResult {
  readonly action: OperatorActionKind;
  readonly operationId: string;
  readonly previousState: OperationState;
  readonly record: OperationRecord;
  readonly nextAction: RecoveryAction | null;
  readonly auditActor: string;
}

const SEVERITY_RANK: Readonly<Record<PartialFailureSeverity, number>> = {
  critical: 3,
  high: 2,
  medium: 1
};

function isTerminal(state: OperationState): boolean {
  return (TERMINAL_OPERATION_STATES as readonly string[]).includes(state);
}

function ageOf(record: OperationRecord, atMs: number): number {
  const updatedAt = Date.parse(record.updatedAt);
  if (Number.isNaN(updatedAt)) return 0;
  return Math.max(0, atMs - updatedAt);
}

function hasRollbackFailure(record: OperationRecord): boolean {
  return record.steps.some(
    (step) =>
      step.rollbackStatus === "rollback_failed" ||
      step.rollbackStatus === "rollback_interrupted"
  );
}

function hasAmbiguousSideEffect(record: OperationRecord): boolean {
  return record.steps.some((step) => decideStep(step) === "confirm");
}

function hasStepFailureOrInterruption(record: OperationRecord): boolean {
  return record.steps.some(
    (step) => step.status === "failed" || step.status === "interrupted"
  );
}

function hasPartialProgress(record: OperationRecord): boolean {
  const completedCount = record.steps.filter(
    (step) => step.status === "succeeded" || step.status === "skipped"
  ).length;
  const hasCommitted = record.steps.some((step) => step.sideEffectCommitted);
  return (
    (completedCount > 0 && completedCount < record.steps.length) ||
    hasCommitted ||
    record.state === "interrupted" ||
    record.state === "failed"
  );
}

/**
 * Determines whether an operation record represents an unresolved partial failure
 * that requires operator visibility or intervention.
 */
export function isUnresolvedPartialFailure(record: OperationRecord): boolean {
  if (isTerminal(record.state)) return false;
  return (
    hasRollbackFailure(record) ||
    hasAmbiguousSideEffect(record) ||
    hasStepFailureOrInterruption(record) ||
    hasPartialProgress(record)
  );
}

/** Classifies an unresolved partial failure by root cause and operational urgency. */
export function classifyPartialFailure(record: OperationRecord): {
  readonly category: PartialFailureCategory;
  readonly severity: PartialFailureSeverity;
} {
  if (hasRollbackFailure(record)) {
    return { category: "rollback_failed", severity: "critical" };
  }
  if (hasAmbiguousSideEffect(record)) {
    return { category: "ambiguous_side_effect", severity: "high" };
  }
  if (hasStepFailureOrInterruption(record) || record.state === "failed") {
    return { category: "retryable_step_failure", severity: "medium" };
  }
  return { category: "in_progress_stalled", severity: "medium" };
}

function allowedActionsFor(
  record: OperationRecord,
  category: PartialFailureCategory
): readonly OperatorActionKind[] {
  const hasCommitted = record.steps.some((step) => step.sideEffectCommitted);

  if (category === "ambiguous_side_effect") {
    const actions: OperatorActionKind[] = ["confirm_applied", "confirm_not_applied"];
    if (hasCommitted) actions.push("rollback");
    actions.push("abandon");
    return actions;
  }

  if (category === "rollback_failed") {
    return ["rollback", "abandon"];
  }

  const actions: OperatorActionKind[] = ["retry"];
  if (hasCommitted) actions.push("rollback");
  actions.push("abandon");
  return actions;
}

function toDashboardItem(record: OperationRecord, atMs: number): OperatorDashboardItem {
  const { category, severity } = classifyPartialFailure(record);
  const completedSteps = record.steps.filter(
    (step) => step.status === "succeeded" || step.status === "skipped"
  ).length;
  const action = nextActionFor(record);
  const failedStep =
    record.steps.find(
      (step) =>
        step.rollbackStatus === "rollback_failed" ||
        step.rollbackStatus === "rollback_interrupted" ||
        step.status === "failed" ||
        step.status === "interrupted"
    ) ?? null;

  return {
    operationId: record.id,
    kind: record.kind,
    state: record.state,
    correlationId: record.correlationId,
    category,
    severity,
    completedSteps,
    totalSteps: record.steps.length,
    failedStepId: failedStep?.id ?? action?.stepId ?? null,
    committedStepIds: record.steps
      .filter((step) => step.sideEffectCommitted)
      .map((step) => step.id),
    ageMs: ageOf(record, atMs),
    updatedAt: record.updatedAt,
    lastErrorCode:
      failedStep?.rollbackErrorCode ??
      failedStep?.errorCode ??
      record.lastErrorCode ??
      null,
    nextAction: action,
    allowedActions: allowedActionsFor(record, category),
    summary: summarizeOperation(record)
  };
}

function compareDashboardItems(
  left: OperatorDashboardItem,
  right: OperatorDashboardItem
): number {
  const severityDiff = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severityDiff !== 0) return severityDiff;

  const ageDiff = right.ageMs - left.ageMs;
  if (ageDiff !== 0) return ageDiff;

  return left.operationId.localeCompare(right.operationId);
}

/**
 * Builds an authorization-enforced snapshot of all unresolved partial failures.
 *
 * Requires `admin:recovery` permission. Returns `permission_denied` for
 * unauthorized roles and `storage_error` if the backing store cannot be read.
 */
export function getOperatorDashboard(
  auth: AuthContext,
  storage: OperationStorage,
  options: OperatorDashboardOptions = {}
): Result<OperatorDashboardSnapshot, OperatorDashboardErrorCode> {
  if (!hasPermission(auth.role, "admin:recovery")) {
    return err("permission_denied");
  }

  let records: readonly OperationRecord[];
  try {
    records = storage.list();
  } catch {
    return err("storage_error");
  }

  const atMs = (options.now ?? (() => Date.now()))();
  const filter = options.filter;

  const countsByCategory: Record<PartialFailureCategory, number> = {
    rollback_failed: 0,
    ambiguous_side_effect: 0,
    retryable_step_failure: 0,
    in_progress_stalled: 0
  };
  const countsBySeverity: Record<PartialFailureSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0
  };

  const allUnresolved: OperatorDashboardItem[] = [];
  for (const record of records) {
    if (!isUnresolvedPartialFailure(record)) continue;
    const item = toDashboardItem(record, atMs);
    countsByCategory[item.category] += 1;
    countsBySeverity[item.severity] += 1;
    allUnresolved.push(item);
  }

  let filtered = allUnresolved;
  if (filter) {
    filtered = allUnresolved.filter((item) => {
      if (filter.kind !== undefined && item.kind !== filter.kind) return false;
      if (filter.category !== undefined && item.category !== filter.category) return false;
      if (filter.severity !== undefined && item.severity !== filter.severity) return false;
      if (filter.minAgeMs !== undefined && item.ageMs < filter.minAgeMs) return false;
      return true;
    });
  }

  filtered.sort(compareDashboardItems);

  const limit =
    filter?.limit !== undefined && Number.isFinite(filter.limit) && filter.limit >= 0
      ? Math.floor(filter.limit)
      : undefined;
  const truncated = limit !== undefined && filtered.length > limit;
  const items = limit !== undefined ? filtered.slice(0, limit) : filtered;

  return ok({
    generatedAt: new Date(atMs).toISOString(),
    totalOperations: records.length,
    unresolvedCount: allUnresolved.length,
    countsByCategory,
    countsBySeverity,
    items,
    truncated
  });
}

/**
 * Executes an authorization-enforced operator recovery action against an
 * unresolved partial failure.
 *
 * Guards against unsafe retries: if an operation has an unconfirmed committed
 * side effect, `retry` is rejected with `confirmation_required` until the
 * operator explicitly resolves it via `confirm_applied` or `confirm_not_applied`.
 */
export async function executeOperatorAction<TContext = unknown>(
  auth: AuthContext,
  request: OperatorActionRequest<TContext>
): Promise<Result<OperatorActionResult, OperatorDashboardErrorCode>> {
  if (!hasPermission(auth.role, "admin:recovery")) {
    return err("permission_denied");
  }

  const auditActor = `maintainer:${auth.userId ?? "unknown"}`;

  if (request.action === "retry") {
    let existing: OperationRecord | undefined;
    try {
      existing = request.options.storage.read(request.options.operationId);
    } catch {
      return err("storage_error");
    }

    if (!existing) return err("unknown_operation");
    if (isTerminal(existing.state)) return err("already_terminal");
    if (hasAmbiguousSideEffect(existing)) return err("confirmation_required");

    const progress = await runOperation(request.definition, {
      ...request.options,
      actor: request.options.actor ?? auditActor
    });
    if (isErr(progress)) return progress;

    return ok({
      action: "retry",
      operationId: existing.id,
      previousState: existing.state,
      record: progress.value.record,
      nextAction: progress.value.nextAction,
      auditActor: request.options.actor ?? auditActor
    });
  }

  if (request.action === "confirm_applied" || request.action === "confirm_not_applied") {
    let existing: OperationRecord | undefined;
    try {
      existing = request.options.storage.read(request.operationId);
    } catch {
      return err("storage_error");
    }
    if (!existing) return err("unknown_operation");

    const resolution = request.action === "confirm_applied" ? "applied" : "not_applied";
    const resolved = resolveInterruptedStepAuthorized(
      auth,
      request.operationId,
      request.stepId,
      resolution,
      {
        ...request.options,
        actor: request.options.actor ?? auditActor
      }
    );
    if (isErr(resolved)) return resolved;

    return ok({
      action: request.action,
      operationId: existing.id,
      previousState: existing.state,
      record: resolved.value,
      nextAction: nextActionFor(resolved.value),
      auditActor: request.options.actor ?? auditActor
    });
  }

  if (request.action === "rollback") {
    let existing: OperationRecord | undefined;
    try {
      existing = request.options.storage.read(request.options.operationId);
    } catch {
      return err("storage_error");
    }
    if (!existing) return err("unknown_operation");

    const rolledBack = await rollbackOperationAuthorized(
      auth,
      request.definition,
      {
        ...request.options,
        actor: request.options.actor ?? auditActor
      },
      request.failureReason
    );
    if (isErr(rolledBack)) return rolledBack;

    return ok({
      action: "rollback",
      operationId: existing.id,
      previousState: existing.state,
      record: rolledBack.value,
      nextAction: nextActionFor(rolledBack.value),
      auditActor: request.options.actor ?? auditActor
    });
  }

  if (request.action === "abandon") {
    let existing: OperationRecord | undefined;
    try {
      existing = request.options.storage.read(request.operationId);
    } catch {
      return err("storage_error");
    }
    if (!existing) return err("unknown_operation");

    const abandoned = abandonOperationAuthorized(auth, request.operationId, {
      ...request.options,
      actor: request.options.actor ?? auditActor
    });
    if (isErr(abandoned)) return abandoned;

    return ok({
      action: "abandon",
      operationId: existing.id,
      previousState: existing.state,
      record: abandoned.value,
      nextAction: nextActionFor(abandoned.value),
      auditActor: request.options.actor ?? auditActor
    });
  }

  return err("invalid_action");
}
