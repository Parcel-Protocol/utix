/**
 * Privacy Redaction Policy for Logs and Exports (#432).
 *
 * Provides a unified, auditable privacy boundary enforcing that:
 * 1. Log and telemetry events never disclose secret seeds, bearer tokens, or sensitive headers.
 * 2. Data export streams mask or omit sensitive fields based on actor authorization scope.
 * 3. Recursive objects, circular references, and deeply nested structures cannot bypass redaction.
 */

import { redact, type TelemetryEvent } from "@/core/telemetry/telemetry";
import {
  applyFieldLevelAuthorization,
  DEFAULT_SENSITIVE_FIELD_RULES,
  sanitizeExportRecord,
  type ExportActor,
  type FieldAuthorizationRule
} from "@/core/export/exporter";
import { err, ok, type Result } from "@/core/result/result";

export type PrivacyErrorCode =
  | "unredacted_secret_detected"
  | "unauthorized_export_scope"
  | "privacy_audit_failed";

export interface PrivacyVerificationReport {
  readonly isCompliant: boolean;
  readonly violations: readonly string[];
  readonly scannedFields: number;
}

const STELLAR_SECRET_PATTERN = /[SM][A-Z2-7]{55}/;
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+/i;

/**
 * Validates whether an object, string, or record contains any unredacted sensitive leaks.
 */
export function scanForSensitiveLeaks(
  data: unknown,
  path = "",
  visited: WeakSet<object> = new WeakSet<object>()
): string[] {
  const violations: string[] = [];

  if (typeof data === "string") {
    if (STELLAR_SECRET_PATTERN.test(data) && !data.includes("[REDACTED]")) {
      violations.push(`Unredacted Stellar secret seed found at ${path || "root"}`);
    }
    if (BEARER_TOKEN_PATTERN.test(data) && !data.includes("[REDACTED]")) {
      violations.push(`Unredacted Bearer token found at ${path || "root"}`);
    }
    return violations;
  }

  if (data === null || typeof data !== "object") {
    return violations;
  }

  if (visited.has(data)) {
    return violations;
  }
  visited.add(data);

  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      violations.push(...scanForSensitiveLeaks(item, `${path}[${index}]`, visited));
    });
    return violations;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const curPath = path ? `${path}.${key}` : key;
    // Disallow raw secret keys holding unmasked strings
    if (/secret|seed|password|token|bearer|key/i.test(key) && !/public/i.test(key)) {
      if (typeof value === "string" && value !== "[REDACTED]" && value !== "[CIRCULAR]" && value !== "[MASKED]") {
        violations.push(`Sensitive key '${curPath}' contains unmasked value`);
      }
    }
    violations.push(...scanForSensitiveLeaks(value, curPath, visited));
  }

  return violations;
}

/**
 * Sanitizes a telemetry log event through the privacy policy engine.
 */
export function sanitizeLogEvent(event: TelemetryEvent): TelemetryEvent {
  return {
    ...event,
    payload: event.payload ? (redact(event.payload) as Record<string, unknown>) : undefined
  };
}

/**
 * Sanitizes an export record using field authorization rules and secret scrubbing.
 */
export function sanitizeExportRecordWithPrivacy(
  record: Record<string, unknown>,
  actor: ExportActor,
  customRules?: readonly FieldAuthorizationRule[]
): Record<string, unknown> {
  const rules = [...DEFAULT_SENSITIVE_FIELD_RULES, ...(customRules ?? [])];
  const sanitized = sanitizeExportRecord(record, actor, rules);
  const authResult = applyFieldLevelAuthorization(sanitized, actor, { rules });
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(authResult.record)) {
    if (value === "[FILTERED: UNAUTHORIZED]") {
      result[key] = "[MASKED]";
    } else {
      result[key] = value;
    }
  }
  for (const [key, val] of Object.entries(record)) {
    if (/secret|seed|password|token|bearer|key/i.test(key) && !/public/i.test(key)) {
      if (result[key] === undefined && val !== undefined) {
        result[key] = "[REDACTED]";
      }
    }
  }
  return result;
}

/**
 * Verifies that a log payload or export envelope satisfies privacy guarantees.
 */
export function verifyPrivacyCompliance(
  data: unknown
): Result<PrivacyVerificationReport, PrivacyErrorCode> {
  const violations = scanForSensitiveLeaks(data);
  const report: PrivacyVerificationReport = {
    isCompliant: violations.length === 0,
    violations,
    scannedFields: typeof data === "object" && data !== null ? Object.keys(data).length : 1
  };

  if (!report.isCompliant) {
    return err("unredacted_secret_detected");
  }

  return ok(report);
}
