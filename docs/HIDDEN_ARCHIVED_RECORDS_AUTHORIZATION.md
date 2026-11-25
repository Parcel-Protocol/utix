# Authorization for Hidden and Archived Records (#435)

## Overview

Utix implements granular access controls for records transitioning through active, hidden, and archived lifecycles:
- **Active records**: Discoverable by record owners, authorized readers, and maintainers.
- **Hidden records**: Isolated records hidden from general viewer queries. To prevent enumeration and side-channel existence probing, unauthorized requests receive `record_not_found` rather than disclosure of existence.
- **Archived records**: Historical records preserved for compliance. Standard queries receive `record_archived` and require explicit archive access permissions.

## Access Rules

| Role / Scope | Active Records | Hidden Records | Archived Records |
| :--- | :--- | :--- | :--- |
| `anonymous` | Denied | `record_not_found` (Non-disclosure) | `authorization_denied` |
| `viewer` | Read if owner/reader | `record_not_found` | `record_archived` |
| `records:read_hidden` | Allowed | Allowed | `record_archived` |
| `records:read_archived` | Allowed | `record_not_found` | Allowed |
| `maintainer` / `admin` | Full Access | Full Access | Full Access |

## State Transitions & Recovery

```
[ Active ] <=====> [ Hidden ]
    ||
    v
[ Archived ] ======> [ Active ] (Restored)
```

- Moving an archived record directly to hidden is disallowed (`invalid_state_transition`); records must be restored first.
- Transient storage contention is handled via `readAuthorizedRecord(..., { maxRetries: 3 })` with exponential backoff.
