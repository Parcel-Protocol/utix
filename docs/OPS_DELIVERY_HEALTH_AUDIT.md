# Secure delivery, dependency status, and signed admin receipts

The core modules here are operator-facing **opt-in seams**. The app remains
read-only and does not sign or submit Stellar transactions. Outbound delivery
must be enabled explicitly by a trusted host application.

## Outbound policy (#440)

Use `createSafeDelivery({ allowlist, send })` to create a delivery function.
Configure exact `https://` origins, allowed MIME types, and a maximum payload
byte size. Empty lists reject everything. Hostname suffix matching, non-HTTPS
URLs, credentials, IP literals, unlisted ports, oversized bodies and unapproved
content types are refused before a transport is invoked.

**Transport requirement:** the injected `send` must set
`redirect: "error"` and enforce the destination policy at its network boundary.
An exact-origin check alone cannot stop DNS rebinding; production transports
must resolve and pin verified public addresses and refuse private, link-local,
loopback and metadata IPs, including after DNS changes. Do not use a generic
redirect-following HTTP client with this seam. Only pre-approved webhook
destinations may be configured.

## Notification/webhook deduplication (#443)

The existing `NotificationStore.publish` already deduplicates notifications
on recipient + event + dedupe key. The webhook verifier already rejects
replayed signature nonces. The added delivery seam reserves a key on
(recipient, event, destination) before dispatch; successful sends commit the
key, definite transport rejection releases it, and thrown/uncertain sends retain
the reservation until its TTL to avoid duplicates. The default claim store is
bounded and in-memory. A multi-instance or restart-safe deployment must inject
a durable atomic claim store; otherwise the guarantee is limited to one
in-memory delivery process. Ensure upstream event IDs are stable and never use
secret message contents as claim keys.

## Public dependency health (#442)

`GET /api/dependencies` runs bounded live checks against configured Horizon
and Soroban RPC endpoints. Only known Stellar public hostnames are accepted;
unknown, missing or malformed URLs return `degraded`, never a false healthy
status. Timeout and 5xx responses are `down`, HTTP 429 is `degraded`;
the endpoint does not publish upstream URLs, response bodies, private health
diagnostics or credentials. The existing status feed schema supplies a stable
public response with `no-store` headers. A failed dependency is reported
without publishing operational secrets. Service-mode notices still apply.

Configured input variables:
- `NEXT_PUBLIC_HORIZON_TESTNET_URL` for the Horizon health GET
- `NEXT_PUBLIC_SOROBAN_RPC_TESTNET_URL` for Soroban JSON-RPC `getHealth`

The probes are observations, not guarantees of transactional availability.
A failed probe is not a reason to mutate any ledger state. The endpoint is
read-only and does not accept caller-supplied target URLs.

## Signed audit receipts (#441)

Use `recordSignedAdminChange(trail, auth, signer, change, trustedPublicKeys)`
for explicit administrative configuration changes. The caller must have
`admin:config`, a known maintainer identity, and an Ed25519 signer whose ID is
present in the trusted key set. The function passes input through existing
audit-field validation and redaction, signs the normalized event, verifies
its detached signature against the trusted public key, and only then appends
it through the existing audit trail. Signature, actor, action, before/after,
target, timestamp and correlation ID are covered. Unauthorized calls and
missing/untrusted keys fail closed without appending an unsigned event.

Keys should come from the operator's trusted, protected signing mechanism;
**never** accept, persist or expose a private key from the browser or a
request payload. The existing audit trail has legacy unsigned events, which
must be treated distinctly from newly signed receipts. This helper does not
automatically convert all prior administrative emitters; integrate it only
at an audited configuration-change boundary.

## Verification and rollback

Run `npm run check` and the focused Vitest suites before requesting review.
New helpers are additive. Rollback consists of removing their integrations;
no data migration or change to the public contract schema is required.
Delivery dedupe state intentionally expires; after an ambiguous send, inspect
the remote side before retrying. For an invalid audit signing configuration,
stop the change and restore trusted key configuration rather than recording
an unsigned fallback.
