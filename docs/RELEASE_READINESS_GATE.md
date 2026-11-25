# Release Readiness Gate (#237)

## Overview
The **Release Readiness Gate** (`scripts/release-readiness-gate.mjs`) is an automated pre-deployment checklist and CI gate that validates that all database migrations, security controls, rollback rehearsals, and core domain invariants are fully verified before promoting a release to production.

Running the gate:
```bash
npm run verify:readiness
# or in JSON format for automated CI pipelines:
node scripts/release-readiness-gate.mjs --json
```

---

## The Four Mandatory Gates

1. **Database & Schema Migrations Gate**:
   - Inspects `core/migration/` components and schema migrations.
   - Verifies that every migration declares dry-run execution (`dryRun`), post-migration invariant checks (`postChecks`), and automated rollback procedures (`rollback` / `rollbackNotes`).
   - Verifies that `MigrationRunner` supports automated rollback on invariant failure (`autoRollbackOnFailure`).

2. **Security & Secret Sanitization Gate**:
   - Scans core code and scripts for unredacted Stellar secret keys (`S[A-Z2-7]{55}`).
   - Scans for dangerous open redirects and `javascript:` URIs in feature anchors.
   - Enforces secret scrubbing policies.

3. **Rollback Rehearsals & Disaster Recovery Gate**:
   - Validates disaster recovery verification logic (`core/recovery/validator.ts`).
   - Enforces conservative expiry (`isExpiredConservatively`) to prevent revival of expired records when client clocks drift backwards.
   - Rehearses clock skew tolerance windows (`validateClockAndExpiryInvariants`).
   - Verifies incident runbook documentation (`core/incident/runbook.ts`).

4. **Smoke Tests & Invariant Verification Gate**:
   - Validates dry-run reconciliation and dry-run-first repair contracts (`scripts/verify-reconciliation.mjs`).
   - Validates audit logging coverage (`scripts/verify-audit.mjs`).
   - Validates feature registry consistency.

---

## Operational Edge Cases

1. **Emergency Patch Releases**:
   - In incident hotfixes, maintainers must not bypass the security or rollback gates.
   - If a migration cannot be safely rolled back, it must be marked `riskLevel: 'critical'`, include explicit manual recovery runbooks, and take an automated pre-migration ledger snapshot.

2. **Mock Secret Keys in Documentation or Tests**:
   - Unit tests and documentation must use placeholder or redacted tokens (`[REDACTED]` or pattern variables) rather than valid base32 Stellar secret keys.

3. **Cross-Timezone Restore Operations**:
   - Rollback rehearsals verify UTC normalization so that timestamps across different timezones and leap-second events do not invalidate restore manifests.

---

## Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
| :--- | :--- | :--- |
| **Missing Rollback Handler** | Migration fails in production with no clean reversion | Gate blocks release with exit code 1 until rollback handler and notes are provided |
| **Leaked Secret Key** | Compromise of master issuing or signer account | Security gate halts build and identifies offending file and line |
| **Clock Drift during Restore** | Disaster recovery manifests rejected due to timestamp drift | Configurable clock skew tolerance window (default 60,000ms) with monotonic watermark checks |

---

## Rollback & Recovery Steps

1. **If Release Gate Fails in CI**:
   - Inspect the printed failure list in the report.
   - Address the specific missing component (e.g., add missing rollback handler, redact test secret, or register invariant check).
   - Re-run `npm run verify:readiness` locally before re-pushing.

2. **If Production Rollback is Required Post-Release**:
   - Follow the disaster recovery runbook (`npm run recovery:validate`).
   - Apply reverse migration via `MigrationRunner.execute(migration, records, { autoRollbackOnFailure: true })`.

## Plan-level migration and rollback checks (#339)

The per-migration checks above look at each migration on its own. Setting `currentVersion` (the deployed schema version) in the `MigrationReleaseConfig` also checks the plan as a whole. The same checks are available standalone through `checkMigrationPlan` in `core/migration/plan-checks.ts`.

| Check | Fails when |
|---|---|
| `migration_chain_continuity` | The plan does not run contiguously from `currentVersion` to `targetVersion`. This covers a gap, an overlap, a wrong starting version, a step that does not move forward, a duplicate migration id, a target below the deployed version, or an empty plan when the version has to change |
| `migration_rollback_readiness` | A migration above `low` risk has no `rollback` handler, or a `high`/`critical` one has no `rollbackChecks` |
| `migration_rollback_rehearsal` | Only when `rehearsalRecords` is set: the sample goes through dry run → apply → post-checks → rollback → rollback checks, chained across the plan. Fails on any failed check, any handler that throws (the rehearsal stops there), or a rollback that does not restore an identical copy of its input |

Edge cases:

- **Opt-in.** Without `currentVersion` the evaluation behaves exactly as before, so existing callers and reports are unchanged. Set it on every new release.
- **Authorization first.** An unauthorized actor is rejected before any plan check runs, so no migration handler executes on their behalf.
- **Caller data is never mutated.** The rehearsal deep-copies the sample through JSON, so it must be JSON-representable.
- **Low-risk migrations** may stay forward-fix-only. Their documented `forwardFixNotes` are still required by the per-migration check.

Recovery: a failing plan check blocks the release before anything is applied. Fix the plan, by adding the missing migration, rollback handler or rollback check, and re-run the evaluation. Nothing has to be undone.
