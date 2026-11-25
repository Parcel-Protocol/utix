# Imported record provenance

Imported records can carry a schema-versioned provenance envelope from
`core/provenance/imported-record.ts`. The envelope records the source, import
time, SHA-256 digest of a canonical JSON representation, and an optional
signer ID/signature.

## Paths

- **Normal:** a maintainer or administrative actor imports a record and receives
  the original record plus a provenance envelope.
- **Failure:** missing source names and invalid records return stable
  provenance error codes before mutation.
- **Retry:** canonicalization sorts object keys, so repeated imports of the
  same record produce the same digest and no duplicate cryptographic state.
- **Authorization:** viewers are denied with `provenance_permission_denied`;
  only actors with `admin:recovery` may execute imports.
- **Tampering:** verification recomputes the canonical digest and rejects
  changed record data.

## Rollback

Provenance is additive. If signature verification is not available, digest
verification remains useful as an integrity check. Removing provenance reads
and envelope fields does not require a storage migration. To roll back a
signed import, remove the envelope for the imported record and restore the
previous record version from the normal backup/recovery mechanism.
