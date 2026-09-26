# Background Worker Framework

Long-running and retryable work does not belong inside request handlers.
`core/workers/` provides a small, dependency-free, in-process queue for
delayed and retryable jobs, produced by `createWorkerFramework()`.

- **Job payload** — `{ id, operation, params, dedupeKey?, maxAttempts,
  attempts, status, enqueuedAt, nextAttemptAt?, lastError?, correlationId }`.
- **Retry policy** — exponential backoff (`delay * 2^(attempt-1)`); when a job
  exhausts its attempts it is **dead-lettered**, keeping its payload and error
  context for inspection.
- **Dead-letter behavior** — `status: "dead_lettered"` with `lastError`
  preserved; jobs never silently disappear.
- **Idempotent reprocessing** — `dedupeKey` makes re-enqueueing a pending job a
  no-op, and `processJob(id)` leaves a finished job untouched.

## Lifecycle

```
enqueue ──► queued ──► running ──► succeeded
                │          │
                │(delay)   └─► retrying ──► running (again)
                │              │
                ▼              ▼(attempts exhausted)
           dead_lettered ◄─────┘
```

## Using it

```ts
import { createWorkerFramework } from "@/core/workers/queue";

const workers = createWorkerFramework({ retryDelayMs: 250, maxAttempts: 3 });

workers.register("mail.send", async (params, { correlationId }) => {
  // work…
}, { maxAttempts: 5, retryDelayMs: 500 });

const job = workers.enqueue({
  operation: "mail.send",
  params: { to: "alice@example.com" },
  dedupeKey: "mail/alice/2026-09-25",
  delayMs: 5_000
});

// somewhere that owns the run loop:
workers.drainDueJobs();
```

Inspect with `inspect()`, `getById(id)` and `retryJob(id)`.

## Moving one operation in already

The Horizon client cache prune was previously a plain call inside request
handlers. It is now the registered `maintenance.prune_horizon_clients` job in
`core/workers/maintenance.ts`. `NetworkProvider.setNetwork()` enqueues it with
a 1s delay so a rapid network switch settles before the cache is torn down.

## Local development

Workers run in-process, so there is no separate daemon. Two workflows:

```bash
npm run test:workers      # the worker suite: retry exhaustion, dedupe, idempotence
npm run check             # full CI gate, includes these tests
```

To watch a job live during development, run the maintenance test in watch mode:

```bash
npm run test:watch -- core/workers
```

To observe a live drain, switch networks in the running app (the prune job is
enqueued) and call `drainDueJobs()` from your console — the job and its
telemetry will appear as structured lines.

## Telemetry

Each job emits `worker.run` (success) or `worker.retry` / `worker.exhausted`
(failure) telemetry with latency, error code and the job's correlation id. See
[docs/TELEMETRY.md](./TELEMETRY.md) for the dashboard queries.