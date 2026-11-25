# Safe Cancellation and Cleanup for Long-Running Jobs

`core/workers/cancellation.ts` provides targeted, authorization-enforced cancellation and deterministic LIFO resource cleanup for individual long-running jobs.

## Lifecycle States

| State            | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `running`        | Job is actively executing and accepting `registerCleanup()` hooks.                       |
| `cancelling`     | Abort signal has been fired; waiting up to `gracePeriodMs` and running LIFO cleanup.     |
| `cancelled`      | Job was cancelled and all registered cleanup hooks succeeded.                            |
| `cleanup_failed` | Job was cancelled, but one or more cleanup hooks threw or timed out. Recoverable via `retryCleanup()`. |
| `completed`      | Job finished normally; cancellation cleanup hooks were not executed.                     |
| `failed`         | Job threw an unhandled error before cancellation was requested.                          |

## Authorization Model

Both `cancelJob` and `retryCleanup` enforce access control before firing any abort signal or running cleanup hooks:

- **`maintainer` (`admin:recovery`)**: Authorized to cancel any managed job and retry failed cleanup.
- **Job owner (`auth.userId === job.ownerId`)**: Authorized to cancel and retry cleanup for their own job.
- **`viewer` / `service` (non-owners) or unrecognized roles**: Rejected with `err("permission_denied")`; the running job is untouched and telemetry records the denied attempt.

## Cleanup, Failure Isolation, and Retry Recovery

- **Strict LIFO order**: Registered cleanup hooks execute in reverse registration order (e.g., release lock → delete temp file → close handle).
- **Failure isolation**: If a cleanup hook throws or exceeds `cleanupTimeoutMs` (`CleanupTimeoutError`), remaining hooks still execute so one failing cleanup does not leak other resources. The job transitions to `cleanup_failed`.
- **Idempotent cleanup retry (`retryCleanup`)**: Re-runs only hooks whose status is not `succeeded`, skipping already-succeeded hooks. Once all remaining hooks succeed, the job transitions from `cleanup_failed` to `cancelled`.

## Edge Cases

- **Non-cooperative handlers (`forced: true`)**: If a handler ignores `context.signal` past `gracePeriodMs`, cancellation proceeds to forced cleanup and marks `forced: true`. Even if the handler eventually resolves later, `runJob` returns `err("job_cancelled")` and never overwrites the `cancelled` state with `completed`.
- **Idempotent repeat cancellation**: Calling `cancelJob` on an already `cancelled` job returns `ok({ job, idempotentReplay: true })` without re-running cleanup hooks. Concurrent `cancelJob` calls share the in-flight cancellation promise.
- **Parent signal propagation**: Passing `parentSignal` (such as `WorkerFramework.signal()`) links the job's `AbortController` to framework shutdown automatically.
- **Terminal / missing / duplicate jobs**: Returns structured `Result` errors (`unknown_job`, `already_completed`, `already_failed`, `not_cleanup_failed`, `duplicate_job`) instead of throwing uncaught exceptions.

## Contract Preservation

This vertical slice is strictly additive:
- Zero changes to `core/workers/queue.ts`, `workerJobMachine`, `JobPayload`, or `AuthContext`.
- No migration is required.
