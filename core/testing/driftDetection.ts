/**
 * Drift detection utilities for comparing live API responses against MSW fixtures.
 *
 * This module provides schema comparison utilities that exclude known-volatile
 * fields (timestamps, cursors, hashes) while detecting structural changes
 * (new fields, removed fields, type changes).
 */

export interface DriftReport {
  drifts: DriftIssue[];
  fixture: string;
  timestamp: string;
  summary: string;
}

export interface DriftIssue {
  type: "added_field" | "removed_field" | "type_changed";
  path: string;
  field: string;
  fixture?: unknown;
  live?: unknown;
}

const VOLATILE_FIELD_PATTERNS = [
  /timestamp/i,
  /created_at/i,
  /updated_at/i,
  /cursor/i,
  /hash/i,
  /ledger_close_time/i,
  /closed_at/i,
  /ledger_entry_change/i,
  /last_modified_ledger_seq/i,
  /live_until_ledger_seq/i,
  /sequence/i
];

function isVolatileField(fieldName: string): boolean {
  return VOLATILE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

function getFieldType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function getAllKeys(obj: unknown, path: string = ""): Set<string> {
  const keys = new Set<string>();

  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    for (const [key, val] of Object.entries(obj)) {
      if (!isVolatileField(key)) {
        keys.add(key);
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          const nested = getAllKeys(val, `${path}${path ? "." : ""}${key}`);
          nested.forEach((k) => keys.add(`${key}.${k}`));
        }
      }
    }
  }

  return keys;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Compares fixture and live response structures, detecting field-level drift.
 * Returns a list of structural differences, ignoring volatile fields.
 */
export function detectDrift(fixture: unknown, liveResponse: unknown): DriftIssue[] {
  const issues: DriftIssue[] = [];

  const fixtureKeys = getAllKeys(fixture);
  const liveKeys = getAllKeys(liveResponse);

  for (const key of fixtureKeys) {
    if (!liveKeys.has(key)) {
      const fixtureVal = getNestedValue(fixture, key);
      issues.push({
        type: "removed_field",
        path: key.split(".")[0],
        field: key,
        fixture: fixtureVal
      });
    } else {
      const fixtureType = getFieldType(getNestedValue(fixture, key));
      const liveType = getFieldType(getNestedValue(liveResponse, key));

      if (fixtureType !== liveType) {
        issues.push({
          type: "type_changed",
          path: key.split(".")[0],
          field: key,
          fixture: fixtureType,
          live: liveType
        });
      }
    }
  }

  for (const key of liveKeys) {
    if (!fixtureKeys.has(key)) {
      const liveVal = getNestedValue(liveResponse, key);
      issues.push({
        type: "added_field",
        path: key.split(".")[0],
        field: key,
        live: liveVal
      });
    }
  }

  return issues;
}

/**
 * Formats drift issues into a human-readable report suitable for CI/GitHub issues.
 */
export function formatDriftReport(fixture: string, issues: DriftIssue[]): DriftReport {
  const summary = [
    `${issues.filter((i) => i.type === "removed_field").length} removed fields`,
    `${issues.filter((i) => i.type === "added_field").length} added fields`,
    `${issues.filter((i) => i.type === "type_changed").length} type changes`
  ]
    .filter((s) => !s.startsWith("0 "))
    .join(", ");

  return {
    drifts: issues,
    fixture,
    timestamp: new Date().toISOString(),
    summary: summary || "No drift detected"
  };
}

/**
 * Compares two response structures and returns only the significant differences.
 * Useful for test assertions.
 */
export function assertNoDrift(fixture: unknown, liveResponse: unknown): void {
  const issues = detectDrift(fixture, liveResponse);

  if (issues.length === 0) return;

  const formattedIssues = issues
    .map((issue) => `  - ${issue.type}: ${issue.field} (${issue.path})`)
    .join("\n");

  throw new Error(`Response shape drift detected:\n${formattedIssues}`);
}
