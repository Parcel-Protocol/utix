# Expiring Capability Grants for Sensitive Actions (#434)

## Overview

High-privilege sensitive actions (e.g., `admin:emergency_recovery`, private key rotations, deep audit access) require time-boxed capability grants rather than indefinite ambient authority.

`core/authorizations/capabilities.ts` provides:
- Cryptographic capability token issuance.
- Bounded invocation counts (`maxUses` / `remainingUses`).
- Expiration instants (`expiresAt`) derived from TTL and validated against the clock.
- Immediate revocation with audited reasoning.
- Non-exhausting execution wrappers that preserve tokens on transient failure retries.

## Capability Lifecycle

```
[ Active ] --- (consume) ---> [ Decrement Remaining ] ---> [ Exhausted ]
    |                                                            ^
    |--- (clock >= expiresAt) -----------------------------------> [ Expired ]
    |
    |--- (revoked by maintainer) -------------------------------> [ Revoked ]
```

## Error Codes

- `grantor_unauthorized`: Grantor lacks administrative/maintainer credentials.
- `capability_expired`: Invocation attempted after `expiresAt`.
- `capability_exhausted`: Invocation limit reached (`remainingUses === 0`).
- `capability_revoked`: Grant explicitly revoked prior to expiry.
- `capability_unauthorized`: Grantee identity or requested capability does not match grant scope.
