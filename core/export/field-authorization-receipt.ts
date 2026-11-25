/**
 * Field-level export authorization receipts (#457).
 *
 * `exporter.ts` already redacts fields. What it does not produce is a durable,
 * reviewable answer to "why did this export contain (or omit) that field?".
 * This module adds that answer without changing the export envelope or any
 * existing export contract.
 *
 * A receipt records the *decision* for each requested field — allow, mask or
 * omit — plus who asked, under which scope and schema version. It never stores
 * a field value. A SHA-256 digest over the decision set makes a tampered
 * receipt detectable. Decisions are derived with the exporter's own rule
 * precedence (combined defaults + request rules, first match wins, only a
 * `maintainer` actor bypasses a rule), so a receipt cannot claim `allow` where
 * `exportRecords` would redact the field.
 *
 * Paths covered:
 * - normal: a permitted actor gets a stable receipt id and explicit decisions;
 * - failure: malformed/duplicate fields, bad keys and out-of-scope requests are
 *   refused with typed codes;
 * - retry: the same key, actor and inputs produce the same receipt id; callers
 *   that need a byte-identical digest inject a clock;
 * - authorization: maintainers (or services with `export:audit`) see reasons;
 *   every other actor gets a sanitized, decision-only view and cannot read a
 *   receipt belonging to someone else.
 *
 * Revocation is advisory: `revoked` is deliberately excluded from the digest
 * so a revoked receipt still verifies. It is a disclosure control for this
 * module, not a persisted authorization record — callers that need an
 * authoritative deny-list must persist the revocation in their own store.
 */

import { isValidIdempotencyKey } from "@/core/idempotency/idempotency";
import { sha256Hex } from "@/core/ledger/sha256";
import { err, ok, type Result } from "@/core/result/result";
import {
  authorizeExport,
  DEFAULT_SENSITIVE_FIELD_RULES,
  EXPORT_CURRENT_SCHEMA_VERSION,
  EXPORT_DEFAULT_TTL_MS,
  type ExportActor,
  type ExportScope,
  type FieldAuthorizationRule
} from "./exporter";
import type { FieldAction } from "./permission-export";

export const EXPORT_FIELD_RECEIPT_VERSION = 1;
export const EXPORT_FIELD_AUDIT_PERMISSION = "export:audit";

export type ExportFieldReceiptErrorCode =
  | "export_receipt_invalid"
  | "export_receipt_unauthorized";

export interface ExportFieldDecisionRecord {
  readonly field: string;
  readonly action: FieldAction;
  readonly reason: string;
}

export interface ExportFieldReceipt {
  readonly version: typeof EXPORT_FIELD_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly schemaVersion: string;
  readonly scope: ExportScope;
  readonly actorKind: ExportActor["kind"];
  readonly actorId?: string;
  readonly recordType: string;
  /** Sorted by field name; duplicate field names are refused at build time. */
  readonly fields: readonly ExportFieldDecisionRecord[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly digest: string;
}

export interface SanitizedExportFieldReceipt extends Omit<ExportFieldReceipt, "fields"> {
  readonly fields: readonly {
    readonly field: string;
    readonly action: FieldAction;
    readonly reason: "restricted";
  }[];
}

export interface BuildExportFieldReceiptRequest {
  readonly actor: ExportActor;
  readonly scope: ExportScope;
  readonly recordType: string;
  readonly schemaVersion: string;
  readonly requestedFields: readonly string[];
  readonly rules?: readonly FieldAuthorizationRule[];
  /** Stable key supplied by the caller, e.g. the export idempotency key. */
  readonly key: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const VALID_ACTIONS: readonly FieldAction[] = ["allow", "omit", "mask", "error"];

/**
 * Mirror `applyFieldLevelAuthorization`: rules are combined defaults-then-
 * request (first match wins), only `kind: "maintainer"` bypasses a rule, and a
 * denial masks only when the rule asks for it. `onDenied: "error"` is reported
 * as `omit` because that is what the exporter actually emits.
 */
function decideExportField(
  field: string,
  actor: ExportActor,
  rules: readonly FieldAuthorizationRule[]
): ExportFieldDecisionRecord {
  const rule = rules.find((item) => item.field === field);
  if (!rule) return { field, action: "allow", reason: "no rule" };
  if (actor.kind === "maintainer") return { field, action: "allow", reason: "maintainer" };

  const permissions = actor.permissions ?? [];
  if (rule.minScope === "maintainer") {
    return {
      field,
      action: rule.onDenied === "mask" ? "mask" : "omit",
      reason: "scope own < maintainer"
    };
  }
  if (rule.requiredPermissions?.length) {
    const missing = rule.requiredPermissions.filter((permission) => !permissions.includes(permission));
    if (missing.length > 0) {
      return {
        field,
        action: rule.onDenied === "mask" ? "mask" : "omit",
        reason: `missing permission: ${missing.join(",")}`
      };
    }
  }
  return { field, action: "allow", reason: "rule satisfied" };
}

/** Identity of the request, deliberately free of wall-clock values so retries agree. */
function receiptIdOf(
  request: BuildExportFieldReceiptRequest,
  fields: readonly string[]
): string {
  return sha256Hex(
    JSON.stringify({
      version: EXPORT_FIELD_RECEIPT_VERSION,
      key: request.key,
      actorKind: request.actor.kind,
      actorId: request.actor.id ?? null,
      permissions: [...(request.actor.permissions ?? [])],
      scope: request.scope,
      schemaVersion: request.schemaVersion,
      recordType: request.recordType,
      fields
    })
  );
}

/** The digest intentionally excludes `revoked`, so revocation does not break verification. */
function digestOf(receipt: ExportFieldReceipt): string {
  return sha256Hex(
    JSON.stringify({
      version: receipt.version,
      receiptId: receipt.receiptId,
      schemaVersion: receipt.schemaVersion,
      scope: receipt.scope,
      actorKind: receipt.actorKind,
      actorId: receipt.actorId ?? null,
      recordType: receipt.recordType,
      fields: receipt.fields.map(({ field, action, reason }) => ({ field, action, reason })),
      createdAt: receipt.createdAt,
      expiresAt: receipt.expiresAt
    })
  );
}

/**
 * Build a deterministic receipt for one export request. The same key and
 * authorization context always yield the same receipt id, even when the clock
 * differs; injecting `now` additionally makes the digest stable across a retry.
 */
export function buildExportFieldReceipt(
  request: BuildExportFieldReceiptRequest
): Result<ExportFieldReceipt, ExportFieldReceiptErrorCode> {
  const authorized = authorizeExport(request.actor, request.scope);
  if (!authorized.ok) return err("export_receipt_unauthorized");

  const key = request.key ?? "";
  const recordType = request.recordType?.trim() ?? "";
  if (!isValidIdempotencyKey(key) || !recordType) return err("export_receipt_invalid");
  if (
    typeof request.schemaVersion !== "string" ||
    request.schemaVersion !== EXPORT_CURRENT_SCHEMA_VERSION
  ) {
    return err("export_receipt_invalid");
  }
  if (!Array.isArray(request.requestedFields) || request.requestedFields.length === 0) {
    return err("export_receipt_invalid");
  }

  const seen = new Set<string>();
  for (const field of request.requestedFields) {
    if (typeof field !== "string" || field.trim() === "" || seen.has(field)) {
      return err("export_receipt_invalid");
    }
    seen.add(field);
  }

  const ttlMs = request.ttlMs ?? EXPORT_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return err("export_receipt_invalid");
  const now = (request.now ?? (() => Date.now()))();
  if (!Number.isFinite(now)) return err("export_receipt_invalid");

  const sortedFields = [...seen].sort();
  const rules = [...DEFAULT_SENSITIVE_FIELD_RULES, ...(request.rules ?? [])];
  const fields = sortedFields.map((field) => decideExportField(field, request.actor, rules));

  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const receipt: ExportFieldReceipt = {
    version: EXPORT_FIELD_RECEIPT_VERSION,
    receiptId: receiptIdOf(request, sortedFields),
    schemaVersion: request.schemaVersion,
    scope: authorized.value,
    actorKind: request.actor.kind,
    ...(request.actor.id ? { actorId: request.actor.id } : {}),
    recordType,
    fields,
    createdAt,
    expiresAt,
    revoked: false,
    digest: ""
  };

  return ok({ ...receipt, digest: digestOf(receipt) });
}

function isReceipt(value: unknown): value is ExportFieldReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ExportFieldReceipt>;
  if (
    item.version !== EXPORT_FIELD_RECEIPT_VERSION ||
    typeof item.receiptId !== "string" ||
    !HEX_64.test(item.receiptId) ||
    typeof item.schemaVersion !== "string" ||
    (item.scope !== "own" && item.scope !== "maintainer") ||
    (item.actorKind !== "user" && item.actorKind !== "maintainer" && item.actorKind !== "service") ||
    typeof item.recordType !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.expiresAt !== "string" ||
    Number.isNaN(Date.parse(item.createdAt)) ||
    Number.isNaN(Date.parse(item.expiresAt)) ||
    Date.parse(item.createdAt) > Date.parse(item.expiresAt) ||
    typeof item.revoked !== "boolean" ||
    typeof item.digest !== "string" ||
    !HEX_64.test(item.digest) ||
    !Array.isArray(item.fields) ||
    item.fields.length === 0
  ) {
    return false;
  }
  if (item.actorId !== undefined && typeof item.actorId !== "string") return false;

  let previous = "";
  for (const field of item.fields) {
    if (!field || typeof field !== "object") return false;
    if (
      typeof field.field !== "string" ||
      field.field.trim() === "" ||
      field.field <= previous ||
      !VALID_ACTIONS.includes(field.action) ||
      typeof field.reason !== "string" ||
      field.reason.trim() === ""
    ) {
      return false;
    }
    previous = field.field;
  }
  return true;
}

/** Recompute the digest. Returns a typed failure for malformed or altered receipts. */
export function verifyExportFieldReceipt(value: unknown): Result<true, ExportFieldReceiptErrorCode> {
  if (!isReceipt(value)) return err("export_receipt_invalid");
  return digestOf(value) === value.digest ? ok(true) : err("export_receipt_invalid");
}

export function isExportFieldReceiptExpired(receipt: ExportFieldReceipt, now: number = Date.now()): boolean {
  return Date.parse(receipt.expiresAt) <= now;
}

function isReceiptOwner(receipt: ExportFieldReceipt, actor: ExportActor): boolean {
  return Boolean(actor.id) && actor.id === receipt.actorId;
}

function canViewFullReceipt(receipt: ExportFieldReceipt, actor: ExportActor): boolean {
  if (actor.kind === "maintainer") return true;
  if (actor.kind === "service") {
    return (actor.permissions ?? []).includes(EXPORT_FIELD_AUDIT_PERMISSION);
  }
  return isReceiptOwner(receipt, actor);
}

/**
 * Disclose a receipt according to the viewer. Decision names are useful to the
 * actor who made the request; policy reasons and the actor id are administrative
 * detail and are withheld from everyone else.
 */
export function revealExportFieldReceipt(
  receipt: ExportFieldReceipt,
  actor: ExportActor
): Result<ExportFieldReceipt | SanitizedExportFieldReceipt, ExportFieldReceiptErrorCode> {
  const verified = verifyExportFieldReceipt(receipt);
  if (!verified.ok) return verified;
  if (canViewFullReceipt(receipt, actor)) return ok(receipt);
  return ok({
    ...receipt,
    actorId: undefined,
    fields: receipt.fields.map(({ field, action }) => ({ field, action, reason: "restricted" as const }))
  });
}

/**
 * Mark a receipt as revoked. Owners and administrators may do this; the flag is
 * advisory as described in the module header and is not part of the digest.
 */
export function revokeExportFieldReceipt(
  receipt: ExportFieldReceipt,
  actor: ExportActor
): Result<ExportFieldReceipt, ExportFieldReceiptErrorCode> {
  const verified = verifyExportFieldReceipt(receipt);
  if (!verified.ok) return verified;
  if (!canViewFullReceipt(receipt, actor)) return err("export_receipt_unauthorized");
  return ok({ ...receipt, revoked: true });
}
