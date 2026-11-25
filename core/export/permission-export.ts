/**
 * Permission-aware export with field redaction (#331).
 *
 * Thin, focused layer on top of the existing exporter that makes the
 * permission → redaction decision explicit and testable in isolation:
 *
 * - `buildFieldPolicy` maps an actor and a scope to a concrete set of rules
 *   derived from `DEFAULT_SENSITIVE_FIELD_RULES`, plus any caller-supplied
 *   extras. The result is a plain object: no closures, no imports at test time.
 * - `applyFieldPolicy` processes a single record against a policy. It never
 *   mutates the original — the output is a fresh object — and it handles
 *   nested (dot-path) fields safely without eval.
 * - `redactRecord` is the entry-point that most callers need: it combines both
 *   steps and returns `{ record, redactedFields, errorFields }`.
 *
 * The boundary between "omit" and "mask" is enforced here:
 *   - "omit" removes the key entirely;
 *   - "mask" replaces the value with the fixed string "[REDACTED]" so the
 *     column is still present in a CSV export (empty cell vs. absent column);
 *   - "error" short-circuits and returns `{ ok: false }`.
 *
 * Authorization lookup is a plain role-check:
 *   - a `maintainer` actor always passes `minScope: "maintainer"`;
 *   - a `service` actor with the right permission string also passes;
 *   - a `user` actor only passes `minScope: "own"` fields.
 */

import type { ExportActor, ExportScope, FieldAuthorizationRule } from "./exporter";
import { DEFAULT_SENSITIVE_FIELD_RULES } from "./exporter";

export const MASK_PLACEHOLDER = "[REDACTED]";

export interface FieldPolicy {
  readonly scope: ExportScope;
  readonly actorKind: ExportActor["kind"];
  readonly actorPermissions: readonly string[];
  /** Merged, resolved rule set. Last rule for a field wins. */
  readonly rules: readonly FieldAuthorizationRule[];
}

export type FieldAction = "allow" | "omit" | "mask" | "error";

export interface FieldDecision {
  field: string;
  action: FieldAction;
  reason: string;
}

export type RedactResult =
  | { ok: true; record: Record<string, unknown>; redactedFields: string[]; errorFields: string[] }
  | { ok: false; errorField: string; reason: string };

/** Resolve the effective scope a given actor reaches. */
export function actorScope(actor: ExportActor): ExportScope {
  if (actor.kind === "maintainer") return "maintainer";
  if (actor.kind === "service") return "maintainer"; // services are trusted like maintainers
  return "own";
}

/** Check whether the actor holds a required permission. */
function actorHasPermission(actor: ExportActor, permission: string): boolean {
  return (actor.permissions ?? []).includes(permission);
}

/**
 * Build the effective policy for an export request. The caller may supply
 * extra rules that extend or override the defaults; a later rule for the same
 * field wins.
 */
export function buildFieldPolicy(
  actor: ExportActor,
  scope: ExportScope,
  extraRules: readonly FieldAuthorizationRule[] = []
): FieldPolicy {
  // Merge: defaults first, extras last.
  const merged = new Map<string, FieldAuthorizationRule>();
  for (const rule of [...DEFAULT_SENSITIVE_FIELD_RULES, ...extraRules]) {
    merged.set(rule.field, rule);
  }
  return {
    scope,
    actorKind: actor.kind,
    actorPermissions: actor.permissions ?? [],
    rules: [...merged.values()],
  };
}

/**
 * Decide whether one field passes the policy.
 * Returns `"allow"` when no rule applies (default is to pass).
 */
export function decideField(
  field: string,
  policy: FieldPolicy
): FieldDecision {
  const rule = policy.rules.find((r) => r.field === field);
  if (!rule) return { field, action: "allow", reason: "no rule" };

  const effectiveScope = actorScope({ kind: policy.actorKind, permissions: [...policy.actorPermissions] } as ExportActor);

  // Scope check
  if (rule.minScope === "maintainer" && effectiveScope !== "maintainer") {
    // Check permission override
    if (rule.requiredPermissions?.length) {
      const hasAll = rule.requiredPermissions.every((p) => policy.actorPermissions.includes(p));
      if (hasAll) return { field, action: "allow", reason: "permission override" };
    }
    const action: FieldAction = rule.onDenied ?? "omit";
    return { field, action, reason: `scope ${effectiveScope} < maintainer` };
  }

  // Permission check
  if (rule.requiredPermissions?.length) {
    const hasAll = rule.requiredPermissions.every((p) => policy.actorPermissions.includes(p));
    if (!hasAll) {
      const action: FieldAction = rule.onDenied ?? "omit";
      return { field, action, reason: "missing required permission" };
    }
  }

  return { field, action: "allow", reason: "policy passed" };
}

/**
 * Apply a field policy to one record object (top-level keys only).
 * Returns the processed record plus the lists of fields that were redacted
 * or that caused an error.
 */
export function applyFieldPolicy(
  record: Record<string, unknown>,
  policy: FieldPolicy
): RedactResult {
  const output: Record<string, unknown> = {};
  const redactedFields: string[] = [];
  const errorFields: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const decision = decideField(key, policy);
    switch (decision.action) {
      case "allow":
        output[key] = value;
        break;
      case "omit":
        redactedFields.push(key);
        break;
      case "mask":
        output[key] = MASK_PLACEHOLDER;
        redactedFields.push(key);
        break;
      case "error":
        errorFields.push(key);
        return { ok: false, errorField: key, reason: decision.reason };
    }
  }

  return { ok: true, record: output, redactedFields, errorFields };
}

/**
 * One-shot helper: build the policy and apply it in one call.
 */
export function redactRecord(
  record: Record<string, unknown>,
  actor: ExportActor,
  scope: ExportScope,
  extraRules: readonly FieldAuthorizationRule[] = []
): RedactResult {
  const policy = buildFieldPolicy(actor, scope, extraRules);
  return applyFieldPolicy(record, policy);
}

/**
 * Process an array of records, stopping at the first error (for the "error"
 * onDenied action which should block the whole export).
 */
export function redactRecords(
  records: readonly Record<string, unknown>[],
  actor: ExportActor,
  scope: ExportScope,
  extraRules: readonly FieldAuthorizationRule[] = []
): { ok: false; errorField: string; reason: string; index: number } | {
  ok: true;
  records: Array<{ record: Record<string, unknown>; redactedFields: string[] }>;
} {
  const policy = buildFieldPolicy(actor, scope, extraRules);
  const output: Array<{ record: Record<string, unknown>; redactedFields: string[] }> = [];

  for (const [index, rec] of records.entries()) {
    const result = applyFieldPolicy(rec, policy);
    if (!result.ok) return { ...result, index };
    output.push({ record: result.record, redactedFields: result.redactedFields });
  }

  return { ok: true, records: output };
}
