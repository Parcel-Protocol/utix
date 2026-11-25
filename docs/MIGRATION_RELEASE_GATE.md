# Migration Release Gate & Recovery Evidence (#462)

## Overview

The Migration Release Gate ensures database and schema migrations are verified prior to production releases. It enforces strict rollback documentation, checks for critical risk overrides, evaluates continuity and rehearsability, executes retryable health probes, and produces cryptographically verifiable rollback evidence bundles.

## Acceptance Criteria & Paths

### 1. Normal Path
- Validates the migration plan against schema version targets.
- Verifies that every migration includes explicit `rollbackNotes` and `forwardFixNotes`.
- Computes SHA-256 hashes of rollback scripts and state snapshots.
- Generates a tamper-evident `RollbackEvidenceBundle` with an `APPROVED` status.

### 2. Failure Paths
- Rejects plans with missing or brief (< 10 characters) rollback notes.
- Blocks migrations marked as `riskLevel: "critical"` unless the explicit `allowCriticalRisk` flag is enabled.
- Rejects fragmented or non-contiguous migration chains.

### 3. Retry Path
- Executes optional readiness probes (e.g. database connectivity, replica lag, snapshot integrity).
- Provides configurable retries (`maxRetries`) and exponential backoff (`initialBackoffMs`).
- Fails only after all probe retries are exhausted.

### 4. Authorization Path
- Gated strictly to `maintainer` and `release_manager` roles.
- Unauthorized roles (`contributor`, `guest`) immediately return `status: "UNAUTHORIZED"` without generating evidence bundles.

## Edge Cases and Rollback Behavior

- **Partial Failures**: If a probe fails after all retries, the release is marked `REJECTED`, and discrepancies are recorded in the report.
- **Rollback Procedure**: In case of deployment rollback, operators use the SHA-256 evidence bundle to verify snapshot integrity before applying reversion scripts.
