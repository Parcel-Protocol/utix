# Durable Notification Preferences and Mandatory Alert Routing (#235)

## Overview
Utix provides a durable notification preference model that allows users and operators to customize optional alerts (such as completed background exports, routine info notices, and retry messages) while guaranteeing that **mandatory lifecycle and security alerts remain strictly deliverable and auditable**.

## Architecture & Data Flow

1. **Preference Persistence (`core/notifications/types.ts`, `store.ts`)**:
   - Preferences are keyed durably per recipient under `utix:notification-preferences:v1:<recipient>`.
   - Granular controls allow filtering by `event` (failure, completed, retry, etc.), `tone` (error, warning, info, success), and `category` (operational, security, lifecycle).
   - Global mute flag allows suppressing routine non-urgent notifications.

2. **Mandatory Alert Classifier**:
   - Alerts with `urgency: "mandatory"`, `category: "security"`, `event: "failure"` with `tone: "error"`, or critical recovery actions bypass user filters.
   - Such alerts are tagged with `routedAs: "mandatory_override"` and delivered to the inbox regardless of quiet mode settings.

3. **Audit Trail**:
   - Every preference change emits `notification_preferences.updated`.
   - Every preference reset emits `notification_preferences.reset`.
   - When an optional alert is dropped, `notification.suppressed_by_preference` is recorded.
   - When a mandatory alert overrides user quiet mode, `notification.mandatory_override` is recorded.

4. **Deduplication ledger**:
   - Inbox entries keep their existing bounded size and `Notification` shape.
   - A separate per-recipient key ledger remembers `(event, dedupeKey)` for
     30 days (up to 1,000 entries) so an inbox eviction does not immediately
     turn a webhook/job retry into a second notification.
   - Existing notifications are still returned for duplicates while present
     in the inbox. If the inbox item was evicted but its dedupe receipt remains,
     `publish()` returns `null` and does not recreate it.

---

## Operational Edge Cases

1. **User Global Mute during Security Incident**:
   - If an account is being drained or an unauthorized signer was added, standard notification filters would ordinarily drop warnings.
   - The mandatory routing model bypasses the mute flag and delivers `security` and `critical` alerts directly.

2. **Storage Eviction / Corrupted LocalStorage**:
   - If stored preferences are corrupted or JSON parsing fails, the store safely falls back to standard default preferences without dropping notifications.

3. **High-Frequency Alert Floods**:
   - Alerts with matching `dedupeKey` and event type are deduplicated by the
     durable key ledger, even after the inbox's bounded history evicts the
     original entry.

---

## Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
| :--- | :--- | :--- |
| **Storage write failure** | Preference update cannot be persisted | Store logs error and falls back to in-memory preferences for session duration |
| **Dedupe ledger write failure** | Notification write may already have succeeded | The call surfaces the storage error; retry checks the inbox first and does not publish a second item. |
| **Dedupe expiry/capacity** | A retry arrives after its receipt expires or is evicted from the 1,000-key bound | A new notification may be created; use a larger server-backed retention store when a longer guarantee is required. |
| **Notification flood** | Inbox exceeds bounded capacity | Bounded circular buffer (`maxEntries = 50`) retains newest alerts; mandatory alerts audited before eviction |
| **Misclassified Alert Category** | A routine alert marked mandatory could annoy users | Strict classification: only `failure+error`, `security`, or explicit `mandatory` qualify |

---

## Rollback & Recovery Steps

1. **Preference Reversion**:
   - Maintainers or users can call `store.resetPreferences(recipient)` to instantly restore clean default routing.

2. **State Recovery**:
   - If bad preference data was written, run `store.resetPreferences(recipient)` or clear the storage key `utix:notification-preferences:v1:<recipient>`.
   - `store.clear(recipient)` removes the inbox and its dedupe receipts. To
     reset dedupe history without clearing the inbox, remove that recipient's
     `utix:notification-dedupe:v1:<recipient>` entry.

## Migration and verification

The notification model and preference storage keys are unchanged. The dedupe
ledger uses a new versioned key and reads as empty for existing profiles, so no
data migration is required. Browser `localStorage` supports persistence across
reloads but not atomic cross-tab claims; a server-side adapter is required for
cross-process exactly-once behavior.

```bash
npm test -- core/notifications
```
