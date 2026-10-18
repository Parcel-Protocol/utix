# Data Export Workflow

`core/export/exporter.ts` is the only sanctioned way to generate structured
exports of operational data. It is privacy-safe by construction:

- **Schema versioning** — every export declares `schemaVersion` (currently
  `1.0`), and generating against an unsupported version fails with
  `schema_unsupported`.
- **Authorization** — exports are scoped. A plain `user` actor may only export
  `scope: "own"` records; `scope: "maintainer"` requires a maintainer actor.
  Anything else returns `export_denied` and records are filtered so a user
  never sees maintainer-only sources.
- **Retention** — every envelope carries `expiresAt`
  (`generatedAt + EXPORT_DEFAULT_TTL_MS`, override with `ttlMs`). Check
  `isExportExpired(envelope)` before serving a stored artifact.
- **Redaction** — secret-shaped values (`S…`/`M…` seeds, keys named
  `secret`/`seed`/`key`/`token`) become `[REDACTED]` before emission.
- **Idempotency** — pass `idempotencyKey` and a retried request replays the
  recorded envelope instead of minting a second artifact. See
  [IDEMPOTENCY.md](./IDEMPOTENCY.md).

## Generating an export

```ts
import { exportRecords, EXPORT_CURRENT_SCHEMA_VERSION } from "@/core/export/exporter";

const result = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user" },
    pageSize: 100,
    page: 1,
    // Optional, but required for any caller that can retry: a repeated request
    // with the same key returns this same envelope.
    idempotencyKey: "export:demo:1"
  },
  mySources // ExportRecordSource[]
);
```

For consumers that page through changing collections, pass the returned
`nextCursor` on the next request instead of calculating an offset:

```ts
const next = exportRecords(
  { ...request, pageSize: 100, cursor: first.value.nextCursor ?? undefined },
  mySources
);
```

The cursor is anchored to a record key, so inserting records before the
anchor does not repeat the current page. The legacy `page` field remains
available for offset-based callers. Filtering by authorization happens before
cursor keys are generated, so a cursor cannot cross an authorization scope.

A source supplies records and declares its own scope:

```ts
const source = {
  recordType: "operation_log",
  schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
  scope: "own",
  collect: () => telemetryEvents
};
```

## Historical trend export

`core/export/trends.ts` exports how operations, failures and volume move over
time. It buckets raw events into UTC windows (`hour`, `day`, or `week`
starting Monday) and generates the result through `exportRecords`, so a trend
export has the same envelope: `schemaVersion`, `generatedAt`, `expiresAt`,
`generator`, pagination, the `export.generate` quota, optional idempotency and
an audit entry for every attempt, including denied ones.

```ts
import { exportTrends } from "@/core/export/trends";

const result = exportTrends(
  {
    window: "day",
    from: "2026-10-01T00:00:00.000Z", // inclusive
    to: "2026-10-08T00:00:00.000Z", // exclusive
    actor: { kind: "maintainer" },
    pageSize: 500
  },
  events // TrendEvent[]: { at, op, result, amountStroops? }
);
```

Each row (record type `metric_trend`, one per window and operation) holds
`windowStart`, `windowEnd`, `op`, `total`, `successes`, `failures`,
`failureRate` and `volumeStroops`. Volume sums `amountStroops` over successful
events only and is a decimal string, so large totals stay exact.

- **Sensitive dimensions** are not exportable. Aggregation reads only `at`,
  `op`, `result` and `amountStroops`, so accounts, addresses, sessions and IPs
  on an event cannot reach a row. Trends are maintainer scope: any other actor
  gets `export_denied`.
- **Bad input fails loudly.** An unknown window, an empty or reversed range,
  more than `TREND_MAX_WINDOWS` (1 000) windows, or an unreadable event
  returns `trend_invalid_window`, `trend_invalid_range`,
  `trend_range_too_large` or `trend_invalid_event` instead of under-counting.
- **Rows are deterministic**: sorted by window then operation, independent of
  event order and of the host time zone.

## Testing

`npm run test` covers large exports (5 000 records, paged without loss), empty
exports, denied (`export_denied`) and unsupported-version exports, redaction,
and retention expiry — see `core/export/__tests__/exporter.test.ts`. Trend
aggregation, date ranges, empty data, permission denial and a 5 000 event
paged export are covered in `core/export/__tests__/trends.test.ts`.

Each export emits `export.generate` and `export.authorize` telemetry; see
[docs/TELEMETRY.md](./TELEMETRY.md).