# Settlement disputes

Settlement disputes are deterministic records attached to one settlement.

## States and transitions

| State | Allowed maintainer actions |
| --- | --- |
| `open` | investigate, resolve, reject |
| `investigating` | resolve, reject |
| `reopened` | investigate, resolve, reject |
| `resolved` | reopen |
| `rejected` | reopen |

The store reopens a resolved or rejected dispute once by default. Configure
`maxReopens` for a deployment-specific policy. Reapplying an identical
idempotency key returns the original dispute; a second claim for the same
settlement is refused with `dispute_duplicate`.

## Evidence and notes

Evidence bundles contain a reference, optional description and optional SHA-256
hash. Evidence and notes are either `public` or `private`. Public items are
included in public-safe views; private items are visible only to maintainers
and the dispute claimant/respondent. Unknown or unauthorized viewers receive
only public content.

The store never places evidence, note text or private descriptions in audit
context. Audit events record state, counts, visibility and attribution.

## API example

```ts
const opened = store.open({
  actor: { kind: "user", id: "account:GCLAIMANT" },
  settlementId: "settle-001",
  reason: "Settlement missing",
  evidence: [{
    kind: "transaction",
    visibility: "public",
    reference: "ledger:123456",
    sha256: "<64 lowercase hexadecimal characters>"
  }]
});

store.resolve({
  actor: { kind: "maintainer", id: "reviewer-1" },
  id: opened.value.id,
  resolution: "Payout replay confirmed"
});
```
