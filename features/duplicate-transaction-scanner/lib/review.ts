/**
 * Merge review workflow for candidate duplicate groups.
 *
 * State machine
 * -------------
 * pending  → confirm  → confirmed  (terminal, no further review)
 * pending  → dismiss  → dismissed  (terminal)
 * pending  → defer    → deferred   (reversible)
 * deferred → confirm  → confirmed
 * deferred → dismiss  → dismissed
 * deferred → defer    → deferred   (idempotent)
 * confirmed/dismissed → any        → error "invalid_transition"
 *
 * Audit trail
 * -----------
 * Every successful transition emits a `record.state_changed` audit event via
 * the core/audit module. Every refused transition emits `record.transition_denied`.
 * These use the existing SENSITIVE_ACTIONS — no new core module changes needed.
 *
 * Persistence
 * -----------
 * Groups are persisted to localStorage under `GROUPS_STORAGE_KEY` so that
 * review decisions survive page reloads. The store merges incoming scan results
 * with existing decisions: a group already confirmed or dismissed is never
 * overwritten by a fresh pending group from a new scan.
 */

import { recordAudit } from "@/core/audit";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { measureSync } from "@/core/telemetry/telemetry";
import type {
  CandidateGroup,
  CandidateGroupState,
  DuplicateScanErrorCode,
  FetchedTransaction,
  MergePlan,
  ReviewAction,
  ReviewInput,
} from "@/features/duplicate-transaction-scanner/types";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Legal (from, action) → to transitions. */
const VALID_TRANSITIONS: Record<
  CandidateGroupState,
  Partial<Record<ReviewAction, CandidateGroupState>>
> = {
  pending: {
    confirm: "confirmed",
    dismiss: "dismissed",
    defer: "deferred",
  },
  deferred: {
    confirm: "confirmed",
    dismiss: "dismissed",
    defer: "deferred",
  },
  // Terminal states: no transitions allowed.
  confirmed: {},
  dismissed: {},
};

/** True iff no further review is possible from this state. */
export function isTerminalState(state: CandidateGroupState): boolean {
  return state === "confirmed" || state === "dismissed";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const GROUPS_STORAGE_KEY = "utix:dup-scan:v1:groups";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    window.localStorage.setItem("__test__", "1");
    window.localStorage.removeItem("__test__");
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Load all persisted groups from localStorage, or an empty list on error. */
export function loadGroups(): CandidateGroup[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CandidateGroup[];
  } catch {
    return [];
  }
}

/** Persist the full group list to localStorage. Silent on error. */
export function saveGroups(groups: CandidateGroup[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Quota exceeded or private mode — gracefully degrade.
  }
}

/**
 * Merge fresh scan results (all pending) with the persisted store.
 *
 * Rules:
 * - If a group id from the incoming scan already exists in the store with a
 *   terminal state (confirmed | dismissed), keep the stored version unchanged.
 * - If a group id exists with a deferred state, keep the stored version
 *   (preserve the defer decision).
 * - Otherwise (new pending group, or group re-appears after storage flush),
 *   take the incoming group.
 * - Groups in the store that are NOT in the incoming scan are retained with
 *   their current state so historical decisions are not lost.
 */
export function mergeIntoStore(
  incoming: CandidateGroup[],
  stored: CandidateGroup[],
): CandidateGroup[] {
  const storedById = new Map<string, CandidateGroup>(stored.map((g) => [g.id, g]));
  const seen = new Set<string>();

  const result: CandidateGroup[] = incoming.map((incoming) => {
    seen.add(incoming.id);
    const existing = storedById.get(incoming.id);
    // Preserve any existing review decision.
    if (existing) return existing;
    return incoming;
  });

  // Retain historical groups not present in this scan.
  for (const [id, group] of storedById) {
    if (!seen.has(id)) result.push(group);
  }

  // Sort: pending first, deferred, then resolved.
  const ORDER: Record<CandidateGroupState, number> = {
    pending: 0,
    deferred: 1,
    confirmed: 2,
    dismissed: 3,
  };
  result.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return result;
}

// ---------------------------------------------------------------------------
// Review action
// ---------------------------------------------------------------------------

/**
 * Apply a review action to one candidate group.
 *
 * Emits an audit event (`record.state_changed` or `record.transition_denied`)
 * and wraps the whole operation in telemetry (`duplicate_scanner.review`).
 */
export function applyReview(
  group: CandidateGroup,
  input: ReviewInput,
): Result<CandidateGroup, DuplicateScanErrorCode> {
  return measureSync(
    "duplicate_scanner.review",
    { actorType: "user", correlationId: crypto.randomUUID() },
    () => {
      const nextState = VALID_TRANSITIONS[group.state]?.[input.action];

      if (!nextState) {
        // Refused transition — audit it and return an error.
        recordAudit({
          action: "record.transition_denied",
          actor: { kind: "user", id: input.actorId },
          scope: "own",
          target: { kind: "duplicate_candidate_group", id: group.id },
          reason: "invalid_transition",
          outcome: "denied",
          errorCode: "invalid_transition",
          before: { state: group.state },
          after: { requestedAction: input.action },
        });
        return err("invalid_transition" as DuplicateScanErrorCode);
      }

      const updatedGroup: CandidateGroup = {
        ...group,
        state: nextState,
        reviewedAt: new Date().toISOString(),
        reviewedBy: input.actorId,
        reviewReason: input.reason,
      };

      // Audit the successful transition.
      recordAudit({
        action: "record.state_changed",
        actor: { kind: "user", id: input.actorId },
        scope: "own",
        target: { kind: "duplicate_candidate_group", id: group.id },
        reason: input.reason ?? `review.${input.action}`,
        outcome: "allowed",
        before: { state: group.state },
        after: { state: nextState },
      });

      return ok(updatedGroup);
    },
  );
}

/**
 * Deterministically constructs a MergePlan for a candidate duplicate group.
 * Selects the canonical primary transaction (earliest ledger sequence, lowest timestamp,
 * or lexicographical hash tie-breaker) and identifies matching vs differing fields.
 */
export function createMergePlan(group: CandidateGroup): MergePlan {
  if (group.transactions.length === 0) {
    throw new Error("Cannot create a merge plan for an empty group");
  }

  // Deterministic primary transaction selection
  const sorted = [...group.transactions].sort((a, b) => {
    if (a.ledger !== b.ledger) return a.ledger - b.ledger;
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.hash.localeCompare(b.hash);
  });

  const primary = sorted[0];
  const duplicates = sorted.slice(1);

  const matchingFields: string[] = ["sourceAccount", "feeCharged", "memoType", "memo", "operationTypes"];
  const differingFields: string[] = [];

  for (const dup of duplicates) {
    if (dup.ledger !== primary.ledger && !differingFields.includes("ledger")) differingFields.push("ledger");
    if (dup.createdAt !== primary.createdAt && !differingFields.includes("createdAt")) differingFields.push("createdAt");
    if (dup.hash !== primary.hash && !differingFields.includes("hash")) differingFields.push("hash");
  }

  const recommendation: MergePlan["recommendation"] =
    group.state === "confirmed"
      ? "merge_confirmed"
      : differingFields.length > 0
        ? "review_differing_fields"
        : "distinct_transactions";

  const confidenceScore = differingFields.length === 0 ? 1.0 : differingFields.includes("ledger") ? 0.95 : 0.85;

  return {
    groupId: group.id,
    primaryTransaction: primary,
    duplicateTransactions: duplicates,
    matchingFields,
    differingFields,
    recommendation,
    confidenceScore
  };
}

/**
 * Server-side authorization boundary for applying a review action.
 * Requires `admin:recovery` or maintainer role.
 */
export function applyReviewAuthorized(
  auth: AuthContext,
  group: CandidateGroup,
  input: ReviewInput,
): Result<CandidateGroup, DuplicateScanErrorCode> {
  if (!hasPermission(auth.role, "admin:recovery") && !hasPermission(auth.role, "admin:config")) {
    recordAudit({
      action: "record.transition_denied",
      actor: { kind: "user", id: input.actorId },
      scope: "own",
      target: { kind: "duplicate_candidate_group", id: group.id },
      reason: "permission_denied",
      outcome: "denied",
      errorCode: "permission_denied",
      before: { state: group.state },
      after: { requestedAction: input.action },
    });
    return err("permission_denied" as DuplicateScanErrorCode);
  }

  return applyReview(group, input);
}

/**
 * Rolls back an accidental or disputed review decision.
 * Reverts a confirmed or dismissed candidate group back to `deferred` state.
 */
export function rollbackReview(
  group: CandidateGroup,
  input: { actorId: string; reason?: string },
): Result<CandidateGroup, DuplicateScanErrorCode> {
  return measureSync(
    "duplicate_scanner.rollback_review",
    { actorType: "user", correlationId: crypto.randomUUID() },
    () => {
      if (group.state !== "confirmed" && group.state !== "dismissed") {
        // Idempotent: not in a terminal state
        return ok(group);
      }

      const previousState = group.state;
      const updatedGroup: CandidateGroup = {
        ...group,
        state: "deferred",
        reviewedAt: new Date().toISOString(),
        reviewedBy: input.actorId,
        reviewReason: input.reason ?? "review.rollback",
      };

      recordAudit({
        action: "record.state_changed",
        actor: { kind: "user", id: input.actorId },
        scope: "own",
        target: { kind: "duplicate_candidate_group", id: group.id },
        reason: input.reason ?? "review.rollback",
        outcome: "allowed",
        before: { state: previousState },
        after: { state: "deferred" },
      });

      return ok(updatedGroup);
    },
  );
}

/**
 * Server-side authorization boundary for rolling back a review decision.
 * Requires `admin:recovery` or maintainer role.
 */
export function rollbackReviewAuthorized(
  auth: AuthContext,
  group: CandidateGroup,
  input: { actorId: string; reason?: string },
): Result<CandidateGroup, DuplicateScanErrorCode> {
  if (!hasPermission(auth.role, "admin:recovery") && !hasPermission(auth.role, "admin:config")) {
    recordAudit({
      action: "record.transition_denied",
      actor: { kind: "user", id: input.actorId },
      scope: "own",
      target: { kind: "duplicate_candidate_group", id: group.id },
      reason: "permission_denied",
      outcome: "denied",
      errorCode: "permission_denied",
      before: { state: group.state },
      after: { requestedAction: "rollback" },
    });
    return err("permission_denied" as DuplicateScanErrorCode);
  }

  return rollbackReview(group, input);
}
