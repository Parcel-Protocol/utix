# Operational correlation, invariants and recovery

This is a read-only Stellar application. The operational tools below change
**only local derived records or in-memory worker state**; they never sign or
submit transactions, and they never rewrite ledger truth.

## Request trace IDs (#431)

The status route echoes a safe `x-correlation-id` response header. A request
may supply an opaque ASCII identifier of 1–128 characters containing letters,
numbers, dot, underscore or hyphen; invalid values are replaced with a fresh ID.
The route emits a structured `api.status` telemetry event with the same ID on
success and on error. Response bodies do not expose exception details.

Other HTTP handlers can opt into
`withRequestCorrelation(request, "api.operation", handler)`; pass the resulting
`context.job({ operation, params })` to the existing worker framework. Worker
jobs already retain `correlationId` during retries and dead-letter recovery.
Without using this wrapper, other routes continue to operate as before.

## Invariant monitoring (#429)

`monitorFinancialInvariants(auth, domainState, reconciliationSnapshot)`
requires `admin:health`. It performs read-only comparisons: the existing
domain invariants, balance-cache versus authoritative ledger snapshots, and
the current owner of transferred tickets versus their latest transfer
recipient. It returns a correlation ID, finding counts and low-cardinality
violation identifiers. Missing transfer history is *not* proof of ownership;
investigate it manually. Never act automatically on a monitor finding.

A fresh, consistent source snapshot is required for meaningful results.
Repeated checks are safe and perform no writes.

## Dead-letter inspection and replay (#430)

`inspectDeadLetters(worker, auth)` lists dead letters with operation, attempts,
error code, correlation ID and whether a checkpoint is present. It intentionally
does **not** expose job params or raw error messages. Only holders of
`admin:recovery` may inspect or recover jobs.

`retryDeadLetter(worker, auth, id, { confirm: id, resume: true })` creates an
idempotent replacement via the existing worker framework. The original remains
terminal and auditable. A missing or mismatched confirmation is rejected.
Set `resume: false` if a checkpoint is suspected to be corrupt. The replacement
is queued rather than run automatically: the operator must separately drain
the queue. Retry only after reviewing the handler's idempotency and external
side effects. In-memory worker state does not survive process restart.

## Resumable orphan repair (#427)

The CLI reuses the versioned, compare-and-set checkpointing and rollback
engine in `core/migration/backfill.ts`. Its repair definition acts on
**local projection JSON records only**, never blockchain ownership.

Input array entries must carry `id`, `orphaned`, `ownerId` and, for orphaned
records, an independently checked `verifiedOwnerId`. If a nonempty recorded
owner conflicts with verified ownership, the record is skipped for manual
review. Missing verification and ambiguous orphan flags are also skipped.

Preview without writes:

```bash
npm run repair:orphans -- --input ./orphan-records.json --json
```

Apply after independently checking ownership evidence (maintainer role only):

```bash
UTIX_USER_ROLE=maintainer npm run repair:orphans -- --input ./orphan-records.json --apply --checkpoint ./orphan-repair.checkpoint.json --batch-size 25
```

After interruption, repeat the **same command and checkpoint path** to resume.
The engine journals the before-images of changed records and uses checkpoint
revision compare-and-set to reject concurrent operators. The original input
is backed up to `<input>.bak` on first write. Review the dry-run diff and
backup before applying; do not overwrite the backup. To roll back:

```bash
UTIX_USER_ROLE=maintainer npm run repair:orphans -- --input ./orphan-records.json --rollback --checkpoint ./orphan-repair.checkpoint.json
```

An error, unverified ownership or stale checkpoint must be investigated, not
force-applied. `--restart` is appropriate only after confirming that the
definition and its version are still valid. Use `npm run check` for full CI
validation.
