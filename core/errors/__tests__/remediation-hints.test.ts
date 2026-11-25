/**
 * Tests for stable API error codes and remediation hints (#335).
 */

import { describe, expect, it } from "vitest";
import {
  EXTENDED_ERROR_CODES,
  getRemediationHint,
  categorise,
  toApiError,
  httpStatus,
  getDefinition,
  type ExtendedErrorCode,
} from "../remediation-hints";
import { ERROR_CODES, type ErrorCode } from "../error-codes";

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED_ERROR_CODES shape
// ─────────────────────────────────────────────────────────────────────────────

describe("EXTENDED_ERROR_CODES shape (#335)", () => {
  it("every key matches its own code field", () => {
    for (const [key, def] of Object.entries(EXTENDED_ERROR_CODES)) {
      expect(def.code).toBe(key);
    }
  });

  it("every definition has a non-empty remediation", () => {
    for (const def of Object.values(EXTENDED_ERROR_CODES)) {
      expect(def.remediation.length).toBeGreaterThan(0);
    }
  });

  it("every definition has a valid HTTP status", () => {
    for (const def of Object.values(EXTENDED_ERROR_CODES)) {
      expect(def.status).toBeGreaterThanOrEqual(400);
      expect(def.status).toBeLessThanOrEqual(599);
    }
  });

  it("covers export, reconciliation and operation_recovery domains", () => {
    const codes = Object.keys(EXTENDED_ERROR_CODES);
    expect(codes.some((c) => c.startsWith("EXPORT_"))).toBe(true);
    expect(codes.some((c) => c.startsWith("RECONCILIATION_"))).toBe(true);
    expect(codes.some((c) => c.startsWith("OPERATION_"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDefinition
// ─────────────────────────────────────────────────────────────────────────────

describe("getDefinition (#335)", () => {
  it("resolves a base error code", () => {
    const def = getDefinition("UNAUTHORIZED");
    expect(def.code).toBe("UNAUTHORIZED");
    expect(def.status).toBe(401);
  });

  it("resolves an extended error code", () => {
    const def = getDefinition("EXPORT_FIELD_DENIED");
    expect(def.code).toBe("EXPORT_FIELD_DENIED");
    expect(def.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRemediationHint
// ─────────────────────────────────────────────────────────────────────────────

describe("getRemediationHint (#335)", () => {
  it("returns a non-empty hint for a base code", () => {
    const hint = getRemediationHint("INVALID_INPUT");
    expect(hint.length).toBeGreaterThan(0);
  });

  it("returns a non-empty hint for every extended code", () => {
    for (const code of Object.keys(EXTENDED_ERROR_CODES) as ExtendedErrorCode[]) {
      expect(getRemediationHint(code).length).toBeGreaterThan(0);
    }
  });

  it("EXPORT_FIELD_DENIED remediation mentions maintainer", () => {
    expect(getRemediationHint("EXPORT_FIELD_DENIED")).toMatch(/maintainer/i);
  });

  it("OPERATION_INTERRUPTED remediation mentions resolveInterruptedStep", () => {
    expect(getRemediationHint("OPERATION_INTERRUPTED")).toMatch(/resolveInterruptedStep/);
  });

  it("RECONCILIATION_DRIFT_DETECTED remediation mentions repair plan", () => {
    expect(getRemediationHint("RECONCILIATION_DRIFT_DETECTED")).toMatch(/repair/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// categorise
// ─────────────────────────────────────────────────────────────────────────────

describe("categorise (#335)", () => {
  it("maps export codes to 'export'", () => {
    expect(categorise("EXPORT_FIELD_DENIED")).toBe("export");
    expect(categorise("EXPORT_FIELD_ERROR")).toBe("export");
    expect(categorise("EXPORT_RECORD_LIMIT")).toBe("export");
  });

  it("maps reconciliation codes to 'reconciliation'", () => {
    expect(categorise("RECONCILIATION_DRIFT_DETECTED")).toBe("reconciliation");
    expect(categorise("RECONCILIATION_SOURCE_UNAVAILABLE")).toBe("reconciliation");
    expect(categorise("RECONCILIATION_PLAN_STALE")).toBe("reconciliation");
  });

  it("maps operation recovery codes to 'operation_recovery'", () => {
    expect(categorise("OPERATION_INTERRUPTED")).toBe("operation_recovery");
    expect(categorise("OPERATION_SIDE_EFFECT_PENDING")).toBe("operation_recovery");
    expect(categorise("OPERATION_ABANDONED")).toBe("operation_recovery");
    expect(categorise("OPERATION_UNKNOWN")).toBe("operation_recovery");
  });

  it("maps UNAUTHORIZED to 'authentication'", () => {
    expect(categorise("UNAUTHORIZED")).toBe("authentication");
  });

  it("maps FORBIDDEN to 'authorization'", () => {
    expect(categorise("FORBIDDEN")).toBe("authorization");
  });

  it("maps INTERNAL_ERROR to 'server_error'", () => {
    expect(categorise("INTERNAL_ERROR")).toBe("server_error");
  });

  it("maps RATE_LIMITED to 'rate_limit'", () => {
    expect(categorise("RATE_LIMITED")).toBe("rate_limit");
  });

  it("maps NETWORK_ERROR to 'network_error'", () => {
    expect(categorise("NETWORK_ERROR")).toBe("network_error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toApiError
// ─────────────────────────────────────────────────────────────────────────────

describe("toApiError (#335)", () => {
  it("builds a full error body for a base code", () => {
    const body = toApiError("INVALID_INPUT");
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.retryable).toBe(false);
    expect(body.category).toBe("validation");
    expect(body.remediation.length).toBeGreaterThan(0);
    expect(body.detail).toBeUndefined();
  });

  it("includes detail when supplied", () => {
    const body = toApiError("EXPORT_FIELD_DENIED", "field: adminNotes");
    expect(body.detail).toBe("field: adminNotes");
  });

  it("builds a correct body for each extended code", () => {
    for (const code of Object.keys(EXTENDED_ERROR_CODES) as ExtendedErrorCode[]) {
      const body = toApiError(code);
      expect(body.code).toBe(code);
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.remediation.length).toBeGreaterThan(0);
      expect(typeof body.retryable).toBe("boolean");
      expect(typeof body.category).toBe("string");
    }
  });

  it("retryable codes are correctly marked", () => {
    expect(toApiError("RECONCILIATION_SOURCE_UNAVAILABLE").retryable).toBe(true);
    expect(toApiError("RECONCILIATION_DRIFT_DETECTED").retryable).toBe(false);
    expect(toApiError("OPERATION_ABANDONED").retryable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// httpStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("httpStatus (#335)", () => {
  it("returns 403 for EXPORT_FIELD_DENIED", () => expect(httpStatus("EXPORT_FIELD_DENIED")).toBe(403));
  it("returns 409 for RECONCILIATION_DRIFT_DETECTED", () => expect(httpStatus("RECONCILIATION_DRIFT_DETECTED")).toBe(409));
  it("returns 503 for RECONCILIATION_SOURCE_UNAVAILABLE", () => expect(httpStatus("RECONCILIATION_SOURCE_UNAVAILABLE")).toBe(503));
  it("returns 410 for OPERATION_ABANDONED", () => expect(httpStatus("OPERATION_ABANDONED")).toBe(410));
  it("returns 404 for OPERATION_UNKNOWN", () => expect(httpStatus("OPERATION_UNKNOWN")).toBe(404));

  it("returns the same status as the base code for base codes", () => {
    expect(httpStatus("UNAUTHORIZED")).toBe(ERROR_CODES.UNAUTHORIZED.status);
    expect(httpStatus("FORBIDDEN")).toBe(ERROR_CODES.FORBIDDEN.status);
  });
});
