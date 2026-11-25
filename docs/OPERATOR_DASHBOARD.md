# Operator Dashboard for Unresolved Partial Failures

`core/operations/operator-dashboard.ts` provides an authorization-enforced operator dashboard and recovery action layer on top of `core/operations/` checkpoints. It surfaces every non-terminal multi-step operation that stopped part-way and guides operators through safe, deterministic recovery.

## Classification & Prioritization

Unresolved partial failures are classified into four categories and three severity tiers:

| Category                 | Severity   | Condition                                                                                   | Allowed Actions                                      |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `rollback_failed`        | `critical` | Any step has `rollbackStatus` of `rollback_failed` or `rollback_interrupted`.               | `rollback`, `abandon`                                |
| `ambiguous_side_effect`  | `high`     | Any step has `sideEffectCommitted === true` without `status === "succeeded"`.               | `confirm_applied`, `confirm_not_applied`, `rollback`, `abandon` |
| `retryable_step_failure` | `medium`   | Any step has `status === "failed"` or `status === "interrupted"` with no committed effect.  | `retry`, `rollback` (if earlier steps committed), `abandon` |
| `in_progress_stalled`    | `medium`   | Operation has partial progress without a recorded step error.                               | `retry`, `rollback` (if earlier steps committed), `abandon` |

Items are deterministically ordered by:
1. **Severity** (`critical` → `high` → `medium`)
2. **Age** (oldest `updatedAt` first)
3. **Operation ID** (lexicographical tie-breaker)

Terminal operations (`completed` and `abandoned`) are always excluded from the unresolved list.

## Authorization Model

Both `getOperatorDashboard` and `executeOperatorAction` enforce the `admin:recovery` permission via `core/auth`:

- **`maintainer`**: Authorized to inspect unresolved partial failures and execute recovery actions. Actions record `maintainer:<userId>` as the audit actor.
- **`viewer` / `service` / unrecognized roles**: Rejected with `err("permission_denied")` before any storage read or state transition occurs.

## Recovery & Rollback Behavior

- **`retry`**: Re-invokes `runOperation` using each step's persisted `idempotencyKey`. Already-succeeded steps are skipped; failed uncommitted steps are retried safely.
- **`confirm_applied` / `confirm_not_applied`**: Resolves an `ambiguous_side_effect` step via `resolveInterruptedStepAuthorized`. Confirming `applied` marks the step succeeded so subsequent `retry` closes out the operation without re-running the step; confirming `not_applied` resets the step to `pending` so `retry` re-attempts it with the same idempotency key.
- **`rollback`**: Invokes `rollbackOperationAuthorized`, compensating committed steps in strict LIFO order with stable rollback idempotency keys (`operation:<id>:step:<stepId>:rollback`).
- **`abandon`**: Transitions the operation to terminal `abandoned` via `abandonOperationAuthorized` while preserving the record for audit history.

## Edge Cases

- **Double-apply protection (`confirmation_required`)**: Attempting `retry` on an operation with an unconfirmed `sideEffectCommitted` step is rejected with `err("confirmation_required")`. Operators must explicitly confirm the external outcome first.
- **Partial rollback failure**: If a compensating rollback step fails, `executeOperatorAction` returns `err("rollback_failed")` and the next `getOperatorDashboard` snapshot elevates the operation to `rollback_failed` (`critical`). Retrying `rollback` is idempotent and resumes from the uncompensated step.
- **Storage errors**: If `storage.list()` or `storage.read()` throws, the dashboard returns `err("storage_error")` rather than throwing uncaught exceptions.
- **Terminal or missing operations**: Actions targeting non-existent operations return `err("unknown_operation")`; retrying a `completed` or `abandoned` operation returns `err("already_terminal")`.
- **Invalid timestamps / clock skew**: Unparseable `updatedAt` timestamps or future timestamps clamp `ageMs` to `0` rather than producing `NaN` or negative durations.

## Contract Preservation

This vertical slice is strictly additive:
- Zero changes to existing `OperationRecord`, `StepCheckpoint`, `OperationStorage`, or `AuthContext` contracts.
- All new exports are re-exported from `core/operations/index.ts`.
- No migration is required.
