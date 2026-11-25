#!/usr/bin/env node
/**
 * Automated Verification Suite for Issues #432, #433, #434, #435
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #435: Add authorization tests for hidden and archived records
 * - Issue #434: Implement expiring capability grants for sensitive actions
 * - Issue #433: Build conflict resolution for concurrent edits
 * - Issue #432: Add privacy redaction tests for logs and exports
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-432-435.mjs
 */

import assert from "node:assert/strict";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #432, #433, #434, #435    ");
console.log("============================================================\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #435: Authorization Tests for Hidden and Archived Records
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #435: Authorization for Hidden and Archived Records...");

const {
  readAuthorizedRecordSync,
  hideRecord,
  unhideRecord,
  archiveAuthorizedRecord,
  restoreAuthorizedRecord,
  listAuthorizedRecords
} = await import("../core/archive/authorized-records.ts");

{
  const recordsMap = new Map();
  const mockStore = {
    read: (id) => recordsMap.get(id),
    write: (record) => { recordsMap.set(record.id, record); },
    list: (filter) => {
      const arr = Array.from(recordsMap.values());
      return filter?.visibility ? arr.filter((r) => r.visibility === filter.visibility) : arr;
    }
  };

  const testRec = {
    id: "rec-test-1",
    schemaVersion: 1,
    visibility: "active",
    ownerId: "owner-1",
    readers: ["reader-1"],
    value: "secure-payload"
  };
  mockStore.write(testRec);

  // 1. Normal read by owner & reader
  const ownerRead = readAuthorizedRecordSync(mockStore, "rec-test-1", { id: "owner-1", role: "viewer" });
  assert.equal(ownerRead.ok, true, "Owner must read active record");

  const readerRead = readAuthorizedRecordSync(mockStore, "rec-test-1", { id: "reader-1", role: "viewer" });
  assert.equal(readerRead.ok, true, "Reader must read active record");

  // 2. Hide record
  const hideRes = hideRecord(mockStore, "rec-test-1", { id: "admin-1", role: "admin" });
  assert.equal(hideRes.ok, true, "Admin must be able to hide record");

  // 3. Non-disclosure to viewer: returns record_not_found
  const viewerRead = readAuthorizedRecordSync(mockStore, "rec-test-1", { id: "reader-1", role: "viewer" });
  assert.equal(viewerRead.ok, false);
  assert.equal(viewerRead.code, "record_not_found", "Hidden record must return record_not_found for safe non-disclosure");

  // 4. Privileged read of hidden record
  const maintRead = readAuthorizedRecordSync(mockStore, "rec-test-1", { id: "maint-1", role: "maintainer" });
  assert.equal(maintRead.ok, true, "Maintainer must read hidden record");

  // 5. Unhide and Archive
  unhideRecord(mockStore, "rec-test-1", { id: "maint-1", role: "maintainer" });
  archiveAuthorizedRecord(mockStore, "rec-test-1", { id: "maint-1", role: "maintainer" });

  const viewerArchRead = readAuthorizedRecordSync(mockStore, "rec-test-1", { id: "reader-1", role: "viewer" });
  assert.equal(viewerArchRead.ok, false);
  assert.equal(viewerArchRead.code, "record_archived", "Archived record must return record_archived to standard viewer");

  // 6. Restore record
  restoreAuthorizedRecord(mockStore, "rec-test-1", { id: "maint-1", role: "maintainer" });
  assert.equal(mockStore.read("rec-test-1").visibility, "active", "Record must be active after restore");
}
console.log("✓ Issue #435 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #434: Expiring Capability Grants for Sensitive Actions
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #434: Expiring Capability Grants for Sensitive Actions...");

const {
  createMemoryCapabilityStore,
  issueCapabilityGrant,
  verifyCapabilityGrant,
  consumeCapabilityGrant,
  revokeCapabilityGrant
} = await import("../core/authorizations/capabilities.ts");

{
  const capStore = createMemoryCapabilityStore();

  // 1. Issue expiring capability
  const issueRes = issueCapabilityGrant(capStore, {
    grantor: "admin-1",
    grantee: "service-worker",
    capability: "admin:emergency_recovery",
    ttlMs: 60_000,
    maxUses: 2,
    actorRole: "admin"
  });
  assert.equal(issueRes.ok, true, "Privileged admin should issue capability grant");
  const grantId = issueRes.value.id;

  // 2. Verify grant
  const verifyRes = verifyCapabilityGrant(capStore, {
    id: grantId,
    grantee: "service-worker",
    capability: "admin:emergency_recovery"
  });
  assert.equal(verifyRes.ok, true, "Valid grant should verify");

  // 3. Consume uses
  const use1 = consumeCapabilityGrant(capStore, {
    id: grantId,
    grantee: "service-worker",
    capability: "admin:emergency_recovery"
  });
  assert.equal(use1.ok, true);
  assert.equal(use1.value.remainingUses, 1);

  const use2 = consumeCapabilityGrant(capStore, {
    id: grantId,
    grantee: "service-worker",
    capability: "admin:emergency_recovery"
  });
  assert.equal(use2.ok, true);
  assert.equal(use2.value.remainingUses, 0);

  // 4. Exhausted grant refused
  const use3 = consumeCapabilityGrant(capStore, {
    id: grantId,
    grantee: "service-worker",
    capability: "admin:emergency_recovery"
  });
  assert.equal(use3.ok, false);
  assert.equal(use3.code, "capability_exhausted");

  // 5. Expired grant refused
  const expiredIssue = issueCapabilityGrant(capStore, {
    grantor: "admin-1",
    grantee: "user-exp",
    capability: "audit:sensitive_view",
    ttlMs: 10,
    actorRole: "admin",
    now: "2026-01-01T00:00:00.000Z"
  });
  const expCheck = verifyCapabilityGrant(capStore, {
    id: expiredIssue.value.id,
    grantee: "user-exp",
    capability: "audit:sensitive_view",
    now: "2026-01-01T00:10:00.000Z"
  });
  assert.equal(expCheck.ok, false);
  assert.equal(expCheck.code, "capability_expired");
}
console.log("✓ Issue #434 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #433: Conflict Resolution for Concurrent Edits
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #433: Conflict Resolution for Concurrent Edits...");

const {
  resolveConcurrentEdit,
  analyzeConflict
} = await import("../core/conflict/resolver.ts");

{
  const baseDoc = {
    id: "doc-10",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "user-1",
    data: { title: "Original Title", description: "Original Description" }
  };

  // Concurrent edit A modifies title -> becomes v2
  const currentDoc = {
    id: "doc-10",
    version: 2,
    updatedAt: "2026-01-01T00:01:00.000Z",
    updatedBy: "editor-a",
    data: { title: "Title Changed By A", description: "Original Description" }
  };

  // Concurrent edit B modified description based on v1
  const patchB = {
    baseVersion: 1,
    editorId: "editor-b",
    changes: { description: "Description Changed By B" }
  };

  // 1. Disjoint 3-way merge succeeds
  const merged = resolveConcurrentEdit(currentDoc, baseDoc, patchB, "three-way-merge");
  assert.equal(merged.ok, true, "Disjoint concurrent field changes should cleanly merge");
  assert.equal(merged.value.data.title, "Title Changed By A");
  assert.equal(merged.value.data.description, "Description Changed By B");
  assert.equal(merged.value.version, 3);

  // 2. Overlapping conflict rejected
  const conflictingPatch = {
    baseVersion: 1,
    editorId: "editor-c",
    changes: { title: "Conflicting Title By C" }
  };
  const conflictRes = resolveConcurrentEdit(currentDoc, baseDoc, conflictingPatch, "three-way-merge");
  assert.equal(conflictRes.ok, false, "Overlapping field edits must be flagged as conflict");
  assert.equal(conflictRes.code, "edit_conflict_detected");
  assert.equal(conflictRes.detail.hasConflict, true);
  assert.deepEqual(conflictRes.detail.conflictingFields, ["title"]);
}
console.log("✓ Issue #433 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #432: Privacy Redaction for Logs and Exports
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #432: Privacy Redaction for Logs and Exports...");

const {
  scanForSensitiveLeaks,
  verifyPrivacyCompliance,
  sanitizeLogEvent,
  sanitizeExportRecordWithPrivacy
} = await import("../core/privacy/redaction-policy.ts");

{
  const testSecretSeed = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";
  const bearerToken = "Bearer token1234567890abcdef";

  // 1. Telemetry log event sanitization
  const logEvent = {
    op: "rpc.call",
    actorType: "system",
    result: "success",
    latencyMs: 15,
    correlationId: "corr-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      seed: testSecretSeed,
      auth: bearerToken,
      safeMetric: 100
    }
  };

  const sanitizedLog = sanitizeLogEvent(logEvent);
  assert.equal(sanitizedLog.payload.seed, "[REDACTED]");
  assert.equal(sanitizedLog.payload.auth, "[REDACTED]");
  assert.equal(sanitizedLog.payload.safeMetric, 100);

  const compliance = verifyPrivacyCompliance(sanitizedLog);
  assert.equal(compliance.ok, true, "Sanitized log should pass compliance verification");

  // 2. Leak scanner detects unredacted secret
  const leaks = scanForSensitiveLeaks({ leak: testSecretSeed });
  assert.equal(leaks.length > 0, true, "Leak scanner must detect unredacted secret seeds");

  // 3. Export record field sanitization
  const exportRec = {
    id: "tx-99",
    amount: "10.00",
    sessionToken: "tok-secret",
    adminNotes: "Internal note",
    internalLatencyMs: 40
  };

  const userExport = sanitizeExportRecordWithPrivacy(exportRec, { kind: "user" });
  assert.equal(userExport.sessionToken, "[REDACTED]");
  assert.equal(userExport.adminNotes, "[MASKED]");
  assert.equal(userExport.internalLatencyMs, undefined);
}
console.log("✓ Issue #432 verified successfully.\n");

console.log("============================================================");
console.log("   ALL 4 HARD CONTRIBUTOR ASSIGNMENTS VERIFIED CLEANLY!      ");
console.log("============================================================\n");
