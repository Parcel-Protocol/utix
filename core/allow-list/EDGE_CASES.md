# Strict Allow-Lists: Edge Cases and Recovery Behavior

## Overview

This document defines edge case handling and recovery/rollback behavior for strict destination and content allow-lists.

## URL Validation Edge Cases

### Leading/Trailing Whitespace
- **Behavior**: Trimmed before validation
- **Recovery**: Supply trimmed URL directly
- **Example**: `"  https://horizon.stellar.org  "` → accepted after trimming

### Query Parameters
- **Behavior**: Preserved in the validated URL but not validated
- **Recovery**: Remove query parameters if authentication tokens are unintentionally embedded
- **Example**: `"https://horizon.stellar.org/?token=secret"` → preserved; use query-less URL if sensitive

### Explicit Ports
- **Behavior**: Only allowed if matching scheme default (80 for http, 443 for https) or explicitly in allow-list
- **Recovery**: Remove port or add to allow-list policy
- **Example**: `"https://horizon.stellar.org:8443"` → rejected unless `8443` in `allowedPorts`

### Embedded Credentials
- **Behavior**: Always rejected (url_has_credentials)
- **Recovery**: Remove credentials; use header-based auth instead
- **Example**: `"https://user:pass@horizon.stellar.org"` → never accepted

### Non-HTTPS Schemes
- **Behavior**: Only https:// is allowed by default
- **Recovery**: Use HTTPS or update policy if HTTP is required (use with caution)

## File Type Validation Edge Cases

### No Extension
- **Behavior**: Rejected (file_type_not_allowed)
- **Recovery**: Add extension matching the content type
- **Example**: `"report"` → `"report.json"`

### Hidden Files (leading dot, no extension)
- **Behavior**: Rejected (file_type_not_allowed)
- **Recovery**: Rename to include valid extension
- **Example**: `".config"` → `"config.json"`

### Case Sensitivity
- **Behavior**: Extensions and MIME types are case-insensitive
- **Recovery**: N/A (handled transparently)
- **Example**: `"Report.JSON"` → accepted as `.json`

### Size Boundaries
- **Behavior**: Exact boundary enforced; files == maxSize are accepted; files > maxSize are rejected
- **Recovery**: Compress or split file content, or increase maxSize in policy
- **Example**: maxSize 10 MiB; 10 MiB file accepted, 10.1 MiB rejected

### MIME Type Mismatch
- **Behavior**: If MIME type provided, must match allow-list
- **Recovery**: Remove MIME type (pass `null`) or correct it
- **Example**: `"report.json"` with MIME `"application/x-executable"` → rejected

### Null MIME Type
- **Behavior**: Accepted if extension is in allow-list
- **Recovery**: N/A (safe fallback)

## Destination Validation Edge Cases

### Secret Seed Prefix Detection
- **Behavior**: Any string starting with `"S"` is rejected (destination_is_secret)
- **Recovery**: Never submit secret seeds; use Stellar public keys (G...) only
- **Example**: `"SAAAAAAAAAAAAAAAAAAA..."` → always rejected before other checks

### Whitespace in Destination
- **Behavior**: Trimmed; empty after trim is rejected
- **Recovery**: Supply trimmed destination
- **Example**: `"  GABC...  "` → trimmed to `"GABC..."`

### Invalid Stellar Key Format
- **Behavior**: Does not match regex /^G[A-Z2-7]{55}$/ → rejected
- **Recovery**: Verify key format; ensure 56 characters starting with `G`
- **Example**: `"G" + "!" * 55` → rejected (invalid base-32 characters)

### Authorization Bypass Attempts
- **Behavior**: Validation is stateless and identity-agnostic; no caller bypass possible
- **Recovery**: N/A (by design)

### Multiple Approvals
- **Behavior**: Both Stellar public keys and allow-listed destinations can coexist in policy
- **Recovery**: Update policy to include new destinations
- **Example**: `allowedDestinations: ["https://webhook.com", "G..."]` with `allowStellarPublicKeys: true`

## Content Validation Edge Cases

### Empty Content
- **Behavior**: Rejected (content_invalid)
- **Recovery**: Supply non-empty content
- **Example**: `""` → rejected

### Non-String Content
- **Behavior**: Rejected (content_invalid)
- **Recovery**: Convert to string before validation
- **Example**: `null`, `undefined`, `123` → rejected

### Content Size Limits
- **Behavior**: Content exceeding maxContentSize is rejected (content_too_large)
- **Recovery**: Compress, split, or increase maxContentSize in policy
- **Example**: maxContentSize 10 MiB; 10.1 MiB content rejected

### Hash Allow-List
- **Behavior**: If `allowedHashes.length > 0`, content hash must be in list
- **Recovery**: Add computed hash to allow-list or update content to match approved hash
- **Example**: Only pre-approved JSON structures accepted

### Pattern Allow-List
- **Behavior**: If `allowedPatterns.length > 0`, content must match at least one pattern
- **Recovery**: Restructure content to match approved pattern
- **Example**: Only JSON structures matching schema `{status: ...}` accepted

### Combined Hash and Pattern Validation
- **Behavior**: If both lists are empty, content passes; if either is non-empty, both checked
- **Recovery**: Update policy to allow approved content
- **Example**: Migrate from hash-based to pattern-based validation

### Deterministic Hashing
- **Behavior**: Identical content always produces identical hash
- **Recovery**: N/A (by design)

## Rollback Scenarios

### Single Validator Failure
- **Recovery Path**:
  1. Identify error code (e.g., `destination_not_allowed`)
  2. Supply corrected input
  3. Revalidate
  
- **Example**:
  ```javascript
  const bad = validateDestination("not-a-key");
  if (!bad.ok) {
    // User corrects input
    const fixed = validateDestination(VALID_STELLAR_KEY);
    // Now ok === true
  }
  ```

### Policy Migration
- **Recovery Path**:
  1. Test new policy against known-good inputs
  2. Incrementally roll out stricter policies
  3. Document policy changes in audit log
  
- **Example**: Transition from `allowStellarPublicKeys: true` to `false` requires migrating users to allow-listed destinations

### Authorization Revocation
- **Recovery Path**:
  1. Remove destination from `allowedDestinations`
  2. Future validations fail with `destination_not_allowed`
  3. User must reapply for authorization or use different destination
  
- **Example**: Revoke webhook destination on security incident

### Content Policy Changes
- **Recovery Path**:
  1. Document old policy (hash-based, pattern-based, or combined)
  2. Transition to new policy (e.g., pattern-based to regex-based)
  3. Provide migration script or manual review for existing content
  
- **Example**: Move from SHA-256 hashes to JSON schema validation

## Contracts and Preservation

### No Breaking Changes to Error Codes
- Existing error codes (`AllowListErrorCode`) are stable
- New codes (`content_invalid`, `content_not_allowed`, `content_too_large`) are opt-in (content validation disabled by default)

### Backward Compatibility
- Default policies remain unchanged for URL, file type, and destination validators
- Content validator is new; callers opt-in by calling `createContentValidator(policy)`

### Migration Example
```javascript
// Old code (still works)
const dest = validateDestination(VALID_STELLAR_KEY);

// New code (content validation)
const content = validateContent('{"status": "ok"}');

// Both can coexist without conflicts
```

## Testing Edge Cases

All edge cases are covered by test cases in `validator.test.ts`:
- **Normal paths**: Valid inputs accepted
- **Failure paths**: Invalid inputs rejected with specific error codes
- **Retry paths**: Corrected inputs after rejection are accepted
- **Authorization paths**: Pre-approval, revocation, and policy enforcement
- **Rollback scenarios**: Recovery from policy changes and failures

## Recommended Practices

1. **Always trim user input** before validation
2. **Never submit secret seeds** to validators
3. **Handle specific error codes** in UI (e.g., show recovery guidance for `destination_not_allowed`)
4. **Log all validation failures** for audit trails
5. **Test policy changes** against existing approved content before deployment
6. **Use pattern-based validation** for content when hash-based is too strict
7. **Document policy decisions** in comments or separate migration guides
