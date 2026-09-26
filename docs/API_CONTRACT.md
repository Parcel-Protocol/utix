# Public API Contract

Utix is a read-only browser toolkit: there is no HTTP service to curl and no
API key to mint. The "public API" is therefore the set of **operation shapes**
that integration points and downstream consumers rely on. This document is the
single source of truth for those shapes, and `core/contract/` enforces them
with drift tests that fail CI whenever a response shape changes incompatibly.

Locked operations (see `core/contract/__tests__/contract.test.ts`):

| Operation           | Shape                                                       |
|---------------------|-------------------------------------------------------------|
| `telemetry.event`   | Structured record emitted by `core/telemetry`               |
| `horizon.error`     | Classified failure from `classifyHorizonError`              |
| `worker.job`        | Job payload from `core/workers`                             |
| `export.envelope`   | Export artifact from `core/export`                          |
| `feature.manifest`  | Registry metadata every feature publishes                   |
| `lifecycle.state`   | Derived state view shared by the UI and API responses        |

## Conventions

- **Results** are `{ ok: true, value }` or `{ ok: false, code, detail? }` — the
  shared `Result` type. Never throw for expected failures.
- **Error codes** are stable strings (`not_found`, `rate_limited`,
  `export_denied`, `schema_unsupported`, …). The UI maps each code to recovery
  copy; consumers can switch on codes, not on English messages.
- **Auth**: read-only by design. No secrets are ever accepted or returned.
  The only authorization decision is export scope — a plain `user` actor may
  request `scope: "own"` only; `scope: "maintainer"` requires a maintainer
  actor, otherwise `export_denied`.
- **Pagination**: exports paginate with `pageSize` / `page`; the envelope
  always carries `recordCount` and `totalRecords`.

## 1. Telemetry record — `telemetry.event`

Every field is required.

```json
{"op":"horizon.request","actorType":"client","result":"failure","latencyMs":10012,"correlationId":"8f0c…01","timestamp":"2026-09-25T12:00:00.000Z","errorCode":"timeout"}
```

```json
{"op":"export.generate","actorType":"user","result":"success","latencyMs":2,"correlationId":"8f0c…02","timestamp":"2026-09-25T12:00:01.000Z"}
```

## 2. Horizon error — `horizon.error`

Output of `classifyHorizonError(error)`: `{ code, detail }`.

```json
{"code":"rate_limited","detail":{"status":429}}
```

```json
{"code":"not_found","detail":{"status":404,"title":"Resource Missing","detail":"The resource at the url requested was not found."}}
```

## 3. Worker job — `worker.job`

```json
{"id":"…","operation":"maintenance.prune_horizon_clients","params":{"network":"mainnet"},"maxAttempts":3,"attempts":0,"status":"queued","enqueuedAt":"2026-09-25T12:00:00.000Z","correlationId":"8f0c…03"}
```

```json
{"id":"…","operation":"flaky.process","attempts":3,"status":"dead_lettered","lastError":{"code":"Error","message":"naive failure"},"enqueuedAt":"2026-09-25T12:00:00.000Z","correlationId":"8f0c…04"}
```

## 4. Export envelope — `export.envelope`

Success:

```json
{"schemaVersion":"1.0","scope":"own","generatedAt":"2026-09-25T12:00:00.000Z","expiresAt":"2026-09-26T12:00:00.000Z","generator":"utix-export@1","correlationId":"8f0c…05","recordCount":2,"page":1,"totalRecords":2,"records":[{"op":"wallet.detect","result":"success","recordType":"operation_log","scope":"own"}]}
```

Failure (authorization):

```json
{"ok":false,"code":"export_denied"}
```

Failure (version):

```json
{"ok":false,"code":"schema_unsupported"}
```

## 5. Feature manifest — `feature.manifest`

What `manifest.ts` publishes for every tool:

```json
{"slug":"payment-qr","title":"Payment QR Generator","description":"Build a SEP-0007 payment request URI and render it as a scannable QR code.","category":"payments","status":"working"}
```

## 6. Record state view — `lifecycle.state`

`stateView(kind, state)` from `core/lifecycle/records.ts`. The UI and an API
consumer receive the *same* object: the label, the tone and the legal events all
come from the lifecycle table, so a badge can never disagree with a payload.

```json
{"kind":"worker_job","state":"retrying","label":"Retrying","tone":"warning","terminal":false,"allowedEvents":["start","fail","exhaust","retry","dead_letter"]}
```

```json
{"kind":"notification","state":"purged","label":"Purged","tone":"danger","terminal":true,"allowedEvents":[]}
```

A rejected transition is a `Result`, not an exception:

```json
{"ok":false,"code":"terminal_state"}
```

Codes: `unknown_record_kind`, `unknown_state`, `unknown_event`,
`invalid_transition`, `terminal_state`. See
[LIFECYCLE.md](./LIFECYCLE.md).

## Drift detection

`npm run test` (or `npm run check`) runs `core/contract/__tests__/contract.test.ts`,
which *captures the real output of each module* and validates it against the
locked schemas above. Adding a required field to a response without updating a
contract, or omitting one, fails the suite:

```bash
npm run test -- core/contract
```

To change an intentionally breaking contract, update this document **and** the
locked `ContractSchema` in the drift test in the same commit.