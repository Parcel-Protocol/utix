#!/usr/bin/env node
/**
 * Automated Verification Suite for Issues #454, #456, #457, #459
 *
 * Verifies the four hard contributor assignments:
 * - Issue #454: Create synthetic monitoring for critical workflows
 * - Issue #456: Add duplicate-submission concurrency coverage
 * - Issue #457: Build privacy-safe export with field-level authorization
 * - Issue #459: Add keyboard and async status accessibility coverage
 *
 * Each issue verifies the normal, failure, retry, and authorization paths.
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-454-456-457-459.mjs
 */

import assert from "node:assert/strict";

console.log("================================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #454, #456, #457, #459      ");
console.log("================================================================\n");

const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const now = () => NOW;

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #454: Synthetic monitoring for critical workflows
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #454: Critical workflow coverage...");

const {
  evaluateWorkflowCoverage,
  runWorkflowCoverage,
  WORKFLOW_SCENARIOS
} = await import("../core/health/critical-workflow-coverage.ts");
const { JOURNEY_IDS } = await import("../core/health/journeys.ts");

const evidenceFor = (journey, scenario, passed = true) => ({
  journey,
  scenario,
  passed,
  observedAt: new Date(NOW).toISOString()
});
const workflowEvidence = JOURNEY_IDS.flatMap((journey) =>
  WORKFLOW_SCENARIOS.map((scenario) => evidenceFor(journey, scenario))
);

// 1. Normal path
const covered = evaluateWorkflowCoverage(workflowEvidence, { now });
assert.equal(covered.ready, true, "#454 full evidence must be ready");
assert.equal(covered.criticalReady, true, "#454 critical journeys must be ready");
assert.equal(covered.coveragePercent, 100, "#454 coverage must be complete");

// 2. Failure path
const partialEvidence = workflowEvidence.filter(
  (item) => !(item.journey === "fee-stats" && item.scenario === "failure")
);
const partial = evaluateWorkflowCoverage(partialEvidence, { now });
assert.equal(partial.ready, false, "#454 a missing scenario must block readiness");
assert.equal(partial.criticalReady, true, "#454 a non-critical gap must not block critical readiness");
assert.ok(partial.missing.includes("fee-stats:failure"), "#454 missing key must be reported");

// 3. Retry path
let coverageAttempts = 0;
const coverageRun = await runWorkflowCoverage({
  auth: { role: "service" },
  now,
  maxAttempts: 2,
  journeys: ["fee-stats"],
  checks: WORKFLOW_SCENARIOS.map((scenario) => ({
    journey: "fee-stats",
    scenario,
    run: () => {
      if (scenario === "retry") {
        coverageAttempts += 1;
        return coverageAttempts < 2
          ? { passed: false, code: "transient_transport_error" }
          : { passed: true, correlationId: "retry-ok" };
      }
      return { passed: true };
    }
  }))
});
assert.equal(coverageRun.ok, true, "#454 authorized coverage run must succeed");
assert.equal(coverageAttempts, 2, "#454 a transient failure must be retried once");
assert.equal(coverageRun.value.ready, true, "#454 retried coverage must be ready");

// 4. Authorization path
let unauthorizedChecks = 0;
const deniedCoverage = await runWorkflowCoverage({
  auth: { role: "viewer" },
  now,
  checks: [
    {
      journey: "fee-stats",
      scenario: "normal",
      run: () => {
        unauthorizedChecks += 1;
        return { passed: true };
      }
    }
  ]
});
assert.equal(deniedCoverage.ok, false, "#454 viewer must be denied");
assert.equal(deniedCoverage.code, "synthetic_unauthorized", "#454 denial code must be stable");
assert.equal(unauthorizedChecks, 0, "#454 denied run must not execute checks");

console.log("    [PASS] Issue #454: Critical workflow coverage verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #456: Duplicate-submission concurrency coverage
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #456: Duplicate-submission concurrency coverage...");

const { createIdempotencyStore } = await import("../core/idempotency/idempotency.ts");
const {
  runDuplicateSubmissionRetry,
  runDuplicateSubmissionScenario
} = await import("../core/idempotency/duplicate-submission.ts");

const submissionStore = createIdempotencyStore();
const baseSubmission = {
  store: submissionStore,
  operation: "transfer.submit",
  request: { amount: 1 },
  actor: { role: "maintainer" }
};

// 1. Normal path
let executions = 0;
const concurrent = await runDuplicateSubmissionScenario({
  ...baseSubmission,
  key: "verify-submit",
  concurrency: 6,
  run: async () => {
    executions += 1;
    return { ok: true, value: "receipt" };
  }
});
assert.equal(concurrent.executions, 1, "#456 concurrent duplicates must execute once");
assert.equal(executions, 1, "#456 side-effect count must be one");
assert.equal(concurrent.inFlight + concurrent.replays, 5, "#456 other attempts must be accounted for");

// 2. Failure path
const failed = await runDuplicateSubmissionScenario({
  ...baseSubmission,
  key: "verify-failed",
  run: async () => ({ ok: false, code: "upstream_failed" })
});
assert.ok(failed.failures.includes("upstream_failed"), "#456 failure must be recorded");

// 3. Retry path
const retriedSubmission = await runDuplicateSubmissionRetry({
  ...baseSubmission,
  key: "verify-retry",
  failedRun: async () => ({ ok: false, code: "temporary_outage" }),
  recoveredRun: async () => ({ ok: true, value: "recovered" })
});
assert.equal(retriedSubmission.recovered, true, "#456 retry must recover");
assert.equal(retriedSubmission.totalExecutions, 2, "#456 failed and recovered runs execute once each");

// 4. Authorization path
const deniedSubmission = await runDuplicateSubmissionScenario({
  ...baseSubmission,
  key: "verify-unauthorized",
  actor: { role: "viewer" },
  run: async () => ({ ok: true, value: "never" })
});
assert.equal(deniedSubmission.authorized, false, "#456 viewer must be denied");
assert.equal(deniedSubmission.executions, 0, "#456 denied actor must not claim a key");

const grantedSubmission = await runDuplicateSubmissionScenario({
  ...baseSubmission,
  key: "verify-unauthorized",
  actor: { role: "viewer", permissions: ["ops:submit"] },
  run: async () => ({ ok: true, value: "granted" })
});
assert.equal(grantedSubmission.executions, 1, "#456 explicit grant must allow one submission");

console.log("    [PASS] Issue #456: Duplicate-submission concurrency coverage verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #457: Privacy-safe export with field-level authorization
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #457: Privacy-safe export authorization receipts...");

const {
  buildExportFieldReceipt,
  EXPORT_FIELD_AUDIT_PERMISSION,
  isExportFieldReceiptExpired,
  revealExportFieldReceipt,
  revokeExportFieldReceipt,
  verifyExportFieldReceipt
} = await import("../core/export/field-authorization-receipt.ts");
const {
  applyFieldLevelAuthorization,
  DEFAULT_SENSITIVE_FIELD_RULES,
  EXPORT_CURRENT_SCHEMA_VERSION
} = await import("../core/export/exporter.ts");

const receiptRequest = {
  actor: { kind: "user", id: "u-1" },
  scope: "own",
  recordType: "transaction_audit",
  schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
  requestedFields: ["ipAddress", "amount", "internalLatencyMs"],
  key: "verify-export-key",
  now,
  ttlMs: 1_000
};

// 1. Normal path
const builtReceipt = buildExportFieldReceipt(receiptRequest);
assert.equal(builtReceipt.ok, true, "#457 normal receipt must build");
const receipt = builtReceipt.value;
assert.deepEqual(
  receipt.fields.map((field) => field.action),
  ["allow", "omit", "mask"],
  "#457 decisions must be sorted and typed"
);
assert.equal(verifyExportFieldReceipt(receipt).ok, true, "#457 receipt digest must verify");

const exportResult = applyFieldLevelAuthorization(
  { amount: "150.00", ipAddress: "203.0.113.5", internalLatencyMs: 45 },
  receiptRequest.actor,
  { rules: DEFAULT_SENSITIVE_FIELD_RULES }
);
assert.equal(exportResult.record.ipAddress, "[FILTERED: UNAUTHORIZED]", "#457 mask decision must match export");
assert.equal("internalLatencyMs" in exportResult.record, false, "#457 omit decision must match export");

// 2. Failure path
const duplicateFields = buildExportFieldReceipt({ ...receiptRequest, requestedFields: ["amount", "amount"] });
assert.equal(duplicateFields.code, "export_receipt_invalid", "#457 duplicate fields must be refused");
const outOfScope = buildExportFieldReceipt({ ...receiptRequest, scope: "maintainer" });
assert.equal(outOfScope.code, "export_receipt_unauthorized", "#457 out-of-scope request must be refused");
const tampered = verifyExportFieldReceipt({ ...receipt, actorId: "attacker" });
assert.equal(tampered.ok, false, "#457 tampered receipt must be detected");

// 3. Retry path
const retriedReceipt = buildExportFieldReceipt(receiptRequest).value;
assert.equal(retriedReceipt.receiptId, receipt.receiptId, "#457 retry must keep the same receipt id");
assert.equal(retriedReceipt.digest, receipt.digest, "#457 injected clock must keep the digest stable");
assert.equal(isExportFieldReceiptExpired(receipt, NOW + 1_000), true, "#457 TTL must expire");

// 4. Authorization path
const strangerView = revealExportFieldReceipt(receipt, { kind: "user", id: "u-2" });
assert.equal(strangerView.ok, true, "#457 sanitized disclosure must succeed");
assert.ok(strangerView.value.fields.every((field) => field.reason === "restricted"), "#457 reasons must be withheld");
assert.equal(strangerView.value.actorId, undefined, "#457 actor id must be withheld");
const auditorView = revealExportFieldReceipt(receipt, {
  kind: "service",
  id: "s-1",
  permissions: [EXPORT_FIELD_AUDIT_PERMISSION]
});
assert.equal(auditorView.value.fields[0]?.reason, "no rule", "#457 auditors must see reasons");
assert.equal(revokeExportFieldReceipt(receipt, { kind: "user", id: "u-2" }).ok, false, "#457 stranger must not revoke");
const revoked = revokeExportFieldReceipt(receipt, receiptRequest.actor);
assert.equal(revoked.ok, true, "#457 owner must be able to revoke");
assert.equal(verifyExportFieldReceipt(revoked.value).ok, true, "#457 revocation is advisory, not a tamper");

console.log("    [PASS] Issue #457: Privacy-safe export authorization receipts verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #459: Keyboard and async status accessibility coverage
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #459: Keyboard and async status accessibility coverage...");

const { A11Y_PATHS, evaluateKeyboardAsyncCoverage } = await import(
  "../core/testing/keyboard-async-coverage.ts"
);
const {
  getStatusAnnouncement,
  getStatusAriaAttributes,
  getStatusLivePoliteness
} = await import("../core/ui/accessibility.ts");

const SUCCESS = "Changes saved";
const FAILURE = "Could not save changes";
const keyboard = (path) => ({
  path,
  focusOrder: ["open", "confirm", "cancel"],
  expectedFocusOrder: ["open", "confirm", "cancel"],
  activatedControlId: "confirm",
  expectedActivationId: "confirm",
  focusReturnedToId: "open",
  expectedFocusReturnId: "open"
});
const status = (path, value) => {
  const attributes = getStatusAriaAttributes(value);
  return {
    path,
    status: value,
    announcement: getStatusAnnouncement(value, SUCCESS, FAILURE),
    politeness: getStatusLivePoliteness(value),
    role: attributes.role,
    busy: attributes["aria-busy"],
    successMessage: SUCCESS,
    errorMessage: FAILURE
  };
};
const a11yInput = () => ({
  keyboard: A11Y_PATHS.map(keyboard),
  asyncStatus: [
    status("normal", "success"),
    status("failure", "error"),
    status("retry", "loading"),
    status("retry", "error"),
    status("retry", "success"),
    status("authorization", "error")
  ]
});

// 1. Normal path
const a11yReady = evaluateKeyboardAsyncCoverage(a11yInput());
assert.equal(a11yReady.ready, true, "#459 all four paths must pass");
assert.deepEqual(a11yReady.missingPaths, [], "#459 no path may be missing");

// 2. Failure path
const failedA11yInput = a11yInput();
failedA11yInput.asyncStatus = failedA11yInput.asyncStatus.map((item) =>
  item.path === "failure" ? { ...item, announcement: "silent", role: "status" } : item
);
const failureReport = evaluateKeyboardAsyncCoverage(failedA11yInput);
assert.equal(
  failureReport.paths.find((item) => item.path === "failure").issues.some((issue) => issue.code === "async_role"),
  true,
  "#459 error must use role=alert"
);

// 3. Retry path
const retryInput = a11yInput();
retryInput.asyncStatus = retryInput.asyncStatus.filter(
  (item) => !(item.path === "retry" && item.status === "success")
);
const retryReport = evaluateKeyboardAsyncCoverage(retryInput);
assert.equal(
  retryReport.paths
    .find((item) => item.path === "retry")
    .issues.some((issue) => issue.code === "async_status_sequence"),
  true,
  "#459 retry must end in a success announcement"
);

// 4. Authorization path
const authInput = a11yInput();
authInput.keyboard = authInput.keyboard.filter((item) => item.path !== "authorization");
authInput.asyncStatus = authInput.asyncStatus.map((item) =>
  item.path === "authorization" ? { ...item, politeness: "polite" } : item
);
const authorizationReport = evaluateKeyboardAsyncCoverage(authInput);
const authorizationCoverage = authorizationReport.paths.find((item) => item.path === "authorization");
assert.ok(
  authorizationCoverage.issues.some((issue) => issue.code === "a11y_evidence_missing"),
  "#459 authorization keyboard evidence is required"
);
assert.ok(
  authorizationCoverage.issues.some((issue) => issue.code === "async_error_not_assertive"),
  "#459 authorization failures must be assertive"
);

console.log("    [PASS] Issue #459: Keyboard and async status accessibility coverage verified\n");

console.log("================================================================");
console.log("   ALL 4 ISSUES (#454, #456, #457, #459) VERIFIED [PASS]       ");
console.log("================================================================");
