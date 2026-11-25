# Versioned migration notes

Storage compatibility is tracked by `core/migration/storage-schema.ts`. The
checked-in V1 and V2 fixtures under `core/migration/__tests__/fixtures/` are
consumer compatibility examples; update them only alongside a deliberate
schema-version change and tests for every supported old shape.

## Current transition: storage V1 to V2

V1 records remain readable as migration input. V2 adds `schemaVersion: 2`,
partition and actor metadata, an integrity checksum, and optional provenance.
The migration preserves ids and payloads; re-running it preserves V2 records
unchanged. Run `npm run test -- core/migration` (or the full `npm run check`)
before release.

Malformed records and unsupported future schema versions must be rejected
before writes. For a failed post-check, restore the pre-migration snapshot or
apply the V2-to-V1 downgrade, then verify record count and ids before serving
traffic. If rollback verification fails, stop migration retries and recover
from the verified snapshot; do not guess at a forward conversion. No existing
consumer contract changes until it explicitly opts into V2.
