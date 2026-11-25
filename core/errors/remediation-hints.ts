/**
 * Stable API error codes and remediation hints (#335).
 *
 * Extends `error-codes.ts` with:
 *
 * 1. New domain-specific codes for export, reconciliation, operation recovery
 *    and field authorization — all areas introduced in this sprint.
 * 2. `getRemediationHint(code)` — a user-facing string for every code
 *    (wraps the `remediation` field for callers that only need that).
 * 3. `categorise(code)` — returns the RFC-7807-style "type" category so
 *    clients can group errors without pattern-matching the string code.
 * 4. `toApiError(code, detail?)` — builds the JSON body for a 4xx/5xx
 *    response in one call.
 *
 * Rules for adding codes:
 * - Never rename or remove an existing code. Add a new one.
 * - The `code` string must equal the key (enforced by `satisfies`).
 * - `remediation` must be actionable — tell the caller what to *do*, not what
 *   went wrong (the `message` already does that).
 * - `retryable: true` only when the *same* request, unchanged, may succeed on
 *   the next attempt.
 */

import {
  ERROR_CODES,
  type ErrorCode,
  type ErrorDefinition,
  getErrorDefinition,
} from "./error-codes";

// ─────────────────────────────────────────────────────────────────────────────
// Extended codes
// ─────────────────────────────────────────────────────────────────────────────

/** Additional codes introduced in sprint #335. */
export const EXTENDED_ERROR_CODES = {
  // ── Export (#331) ─────────────────────────────────────────────────────────
  EXPORT_FIELD_DENIED: {
    code: "EXPORT_FIELD_DENIED",
    message: "Your role does not permit exporting this field",
    remediation:
      "Request export access from a maintainer, or omit the restricted field from your export scope.",
    status: 403,
    retryable: false,
  },
  EXPORT_FIELD_ERROR: {
    code: "EXPORT_FIELD_ERROR",
    message: "A PCI-sensitive field cannot be exported in this context",
    remediation:
      "Remove the PCI-sensitive field from your export request. These fields are never exportable via the API.",
    status: 422,
    retryable: false,
  },
  EXPORT_RECORD_LIMIT: {
    code: "EXPORT_RECORD_LIMIT",
    message: "The export request exceeds the maximum record count",
    remediation: "Reduce the date range or add additional filters to narrow the result set.",
    status: 400,
    retryable: false,
  },

  // ── Reconciliation (#332) ────────────────────────────────────────────────
  RECONCILIATION_DRIFT_DETECTED: {
    code: "RECONCILIATION_DRIFT_DETECTED",
    message: "Cache drift detected between the ledger and stored projections",
    remediation:
      "Run a reconciliation repair plan and review the drift report before retrying the operation.",
    status: 409,
    retryable: false,
  },
  RECONCILIATION_SOURCE_UNAVAILABLE: {
    code: "RECONCILIATION_SOURCE_UNAVAILABLE",
    message: "The ledger source is currently unavailable for reconciliation",
    remediation: "Retry after the Stellar network or Horizon endpoint recovers.",
    status: 503,
    retryable: true,
  },
  RECONCILIATION_PLAN_STALE: {
    code: "RECONCILIATION_PLAN_STALE",
    message: "The reconciliation plan has expired or the state it was based on has changed",
    remediation: "Re-run the dry-run reconciliation to generate a fresh plan before applying.",
    status: 409,
    retryable: false,
  },

  // ── Operation recovery (#330) ────────────────────────────────────────────
  OPERATION_INTERRUPTED: {
    code: "OPERATION_INTERRUPTED",
    message: "The operation was interrupted mid-execution",
    remediation:
      "Call resolveInterruptedStep with the operation ID to decide whether to resume or abandon.",
    status: 409,
    retryable: false,
  },
  OPERATION_SIDE_EFFECT_PENDING: {
    code: "OPERATION_SIDE_EFFECT_PENDING",
    message: "A step with an external side effect requires confirmation before the operation can proceed",
    remediation:
      "Confirm the side effect outcome (applied or not_applied) via resolveInterruptedStep, then retry.",
    status: 409,
    retryable: false,
  },
  OPERATION_ABANDONED: {
    code: "OPERATION_ABANDONED",
    message: "The operation was permanently abandoned",
    remediation: "Start a new operation. The abandoned operation ID cannot be retried.",
    status: 410,
    retryable: false,
  },
  OPERATION_UNKNOWN: {
    code: "OPERATION_UNKNOWN",
    message: "No operation found with the given ID",
    remediation: "Check the operation ID and ensure the operation was created in this environment.",
    status: 404,
    retryable: false,
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ExtendedErrorCode = keyof typeof EXTENDED_ERROR_CODES;

// ─────────────────────────────────────────────────────────────────────────────
// Unified lookup
// ─────────────────────────────────────────────────────────────────────────────

type AnyErrorCode = ErrorCode | ExtendedErrorCode;

function isExtended(code: AnyErrorCode): code is ExtendedErrorCode {
  return code in EXTENDED_ERROR_CODES;
}

export function getDefinition(code: AnyErrorCode): ErrorDefinition {
  if (isExtended(code)) return EXTENDED_ERROR_CODES[code];
  return getErrorDefinition(code);
}

/**
 * Returns the user-facing remediation string for the given error code.
 * This is the single string a UI or API response body should surface.
 */
export function getRemediationHint(code: AnyErrorCode): string {
  return getDefinition(code).remediation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "export"
  | "reconciliation"
  | "operation_recovery";

const EXTENDED_CATEGORIES: Record<ExtendedErrorCode, ErrorCategory> = {
  EXPORT_FIELD_DENIED: "export",
  EXPORT_FIELD_ERROR: "export",
  EXPORT_RECORD_LIMIT: "export",
  RECONCILIATION_DRIFT_DETECTED: "reconciliation",
  RECONCILIATION_SOURCE_UNAVAILABLE: "reconciliation",
  RECONCILIATION_PLAN_STALE: "reconciliation",
  OPERATION_INTERRUPTED: "operation_recovery",
  OPERATION_SIDE_EFFECT_PENDING: "operation_recovery",
  OPERATION_ABANDONED: "operation_recovery",
  OPERATION_UNKNOWN: "operation_recovery",
};

function statusToCategory(status: number): ErrorCategory {
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409 || status === 410) return "conflict";
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 504) return "network_error";
  return "server_error";
}

export function categorise(code: AnyErrorCode): ErrorCategory {
  if (isExtended(code)) return EXTENDED_CATEGORIES[code];
  return statusToCategory(getErrorDefinition(code).status);
}

// ─────────────────────────────────────────────────────────────────────────────
// API error body builder
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  code: string;
  message: string;
  remediation: string;
  retryable: boolean;
  category: ErrorCategory;
  detail?: string;
}

/**
 * Builds the JSON body for a 4xx/5xx API response.
 * Pass `detail` for context specific to the failing request (never secret).
 */
export function toApiError(code: AnyErrorCode, detail?: string): ApiErrorBody {
  const def = getDefinition(code);
  return {
    code: def.code,
    message: def.message,
    remediation: def.remediation,
    retryable: def.retryable,
    category: categorise(code),
    ...(detail !== undefined && { detail }),
  };
}

/**
 * Returns the HTTP status code for an error code.
 */
export function httpStatus(code: AnyErrorCode): number {
  return getDefinition(code).status;
}
