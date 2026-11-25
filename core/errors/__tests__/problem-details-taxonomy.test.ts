/**
 * Stable Problem-Details Error Taxonomy — extended coverage (#452)
 *
 * Covers the normal, failure, retry, and authorization paths for the RFC 7807
 * problem-details taxonomy, the stability contract, and the bridge adapters
 * from Horizon and Soroban RPC error codes.
 *
 * Run individually:
 *   npm test -- core/errors/__tests__/problem-details-taxonomy
 */

import { describe, expect, it } from "vitest";
import {
  getProblemDefinition,
  horizonToProblemDetails,
  isProblemRetryable,
  PROBLEM_CODES,
  problemDetailsFromCode,
  rpcToProblemDetails,
  type ProblemCode,
  type ProblemDetails,
} from "@/core/errors/problem-details";
import { classifyHorizonError } from "@/core/horizon/errors";
import { classifyRpcError, classifyRpcTransportError } from "@/core/rpc/errors";
import { RPC_STANDARD_CODES } from "@/core/rpc/client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertValidProblemDetails(pd: ProblemDetails, label = ""): void {
  const ctx = label ? ` [${label}]` : "";
  expect(typeof pd.type, `type${ctx}`).toBe("string");
  expect(pd.type, `type starts with https://utix.dev/problems/${ctx}`).toMatch(
    /^https:\/\/utix\.dev\/problems\//
  );
  expect(typeof pd.title, `title${ctx}`).toBe("string");
  expect(pd.title.length, `title non-empty${ctx}`).toBeGreaterThan(0);
  expect(typeof pd.status, `status${ctx}`).toBe("number");
  expect(Number.isFinite(pd.status), `status finite${ctx}`).toBe(true);
  expect(pd.status, `status in 400-599${ctx}`).toBeGreaterThanOrEqual(400);
  expect(pd.status, `status in 400-599${ctx}`).toBeLessThanOrEqual(599);
  expect(typeof pd.detail, `detail${ctx}`).toBe("string");
  expect(pd.detail.length, `detail non-empty${ctx}`).toBeGreaterThan(0);
  expect(typeof pd.code, `code${ctx}`).toBe("string");
  expect(pd.code, `code lowercase_snake${ctx}`).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(typeof pd.retryable, `retryable boolean${ctx}`).toBe("boolean");
  expect(typeof pd.hint, `hint${ctx}`).toBe("string");
  expect(pd.hint.length, `hint non-empty${ctx}`).toBeGreaterThan(0);
}

// ─── Normal path ──────────────────────────────────────────────────────────────

describe("#452 — stable problem-details error taxonomy", () => {
  describe("normal path: wire shape invariants", () => {
    it("every entry in PROBLEM_CODES produces a valid ProblemDetails envelope", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        const pd = problemDetailsFromCode(code);
        assertValidProblemDetails(pd, code);
      }
    });

    it("type URI is permanent: contains only the slug derived from the code", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        const def = getProblemDefinition(code);
        const expectedSlug = code.replace(/_/g, "-");
        expect(def.type, code).toBe(`https://utix.dev/problems/${expectedSlug}`);
      }
    });

    it("code on the envelope always matches the lookup key", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        const def = getProblemDefinition(code);
        expect(def.code).toBe(code);
      }
    });

    it("retryable is exactly true for transport-layer timeout and rate-limit codes", () => {
      const retryableCodes: ProblemCode[] = [
        "horizon_rate_limited",
        "horizon_server_error",
        "horizon_network_unavailable",
        "horizon_timeout",
        "rpc_server_error",
        "rpc_network_unavailable",
        "rpc_timeout",
        "sequence_mismatch",
        "internal_error",
      ];

      for (const code of retryableCodes) {
        expect(isProblemRetryable(code), code).toBe(true);
      }
    });

    it("retryable is exactly false for client-error validation codes", () => {
      const nonRetryableCodes: ProblemCode[] = [
        "validation_error",
        "invalid_address",
        "invalid_amount",
        "invalid_asset_code",
        "missing_required_field",
        "account_not_found",
        "transaction_not_found",
        "transaction_malformed",
        "insufficient_fee",
      ];

      for (const code of nonRetryableCodes) {
        expect(isProblemRetryable(code), code).toBe(false);
      }
    });

    it("problemDetailsFromCode passes correlationId through the envelope", () => {
      const pd = problemDetailsFromCode("account_not_found", {
        correlationId: "test-corr-123",
      });
      expect(pd.correlationId).toBe("test-corr-123");
    });

    it("problemDetailsFromCode sets instance URI when provided", () => {
      const pd = problemDetailsFromCode("validation_error", {
        instance: "/tools/balance-viewer?address=G...",
      });
      expect(pd.instance).toBe("/tools/balance-viewer?address=G...");
    });

    it("problemDetailsFromCode passes non-breaking extensions through", () => {
      const pd = problemDetailsFromCode("account_not_found", {
        extensions: { network: "testnet", extra: 42 },
      });
      expect(pd.extensions).toEqual({ network: "testnet", extra: 42 });
    });

    it("overrideDetail replaces the default safe message", () => {
      const custom = "Custom sanitised detail for this occurrence.";
      const pd = problemDetailsFromCode("validation_error", { overrideDetail: custom });
      expect(pd.detail).toBe(custom);
    });

    it("default detail is taken from the taxonomy — not from user input", () => {
      const pd = problemDetailsFromCode("account_not_found");
      const def = getProblemDefinition("account_not_found");
      expect(pd.detail).toBe(def.detail);
    });

    it("envelope with no options omits optional fields gracefully", () => {
      const pd = problemDetailsFromCode("internal_error");
      expect(pd.correlationId).toBeUndefined();
      expect(pd.instance).toBeUndefined();
      expect(pd.extensions).toBeUndefined();
    });
  });

  // ─── Failure path ───────────────────────────────────────────────────────────

  describe("failure path: Horizon bridge adapter", () => {
    it("horizonToProblemDetails maps every HorizonErrorCode to a valid envelope", () => {
      const horizonCodes = [
        "not_found",
        "rate_limited",
        "bad_request",
        "server_error",
        "network_unavailable",
        "timeout",
        "unknown",
      ] as const;

      for (const hCode of horizonCodes) {
        const classified = classifyHorizonError({ status: 500, detail: "err", extras: {} }, hCode);
        const pd = horizonToProblemDetails(classified);
        assertValidProblemDetails(pd, `horizon:${hCode}`);
      }
    });

    it("horizon rate_limited maps to a retryable ProblemDetails", () => {
      const classified = classifyHorizonError({ status: 429, detail: "rate limited", extras: {} }, "rate_limited");
      const pd = horizonToProblemDetails(classified);
      expect(pd.retryable).toBe(true);
      expect(pd.code).toBe("horizon_rate_limited");
    });

    it("horizon not_found maps to a non-retryable 404 ProblemDetails", () => {
      const classified = classifyHorizonError({ status: 404, detail: "not found", extras: {} }, "not_found");
      const pd = horizonToProblemDetails(classified);
      expect(pd.retryable).toBe(false);
      expect(pd.status).toBe(404);
      expect(pd.code).toBe("horizon_not_found");
    });

    it("horizonToProblemDetails passes correlationId from classification", () => {
      const classified = classifyHorizonError(
        { status: 500, detail: "err", extras: {} },
        "server_error",
        "corr-999"
      );
      const pd = horizonToProblemDetails(classified);
      expect(pd.correlationId).toBe("corr-999");
    });

    it("horizonToProblemDetails never echoes raw Horizon detail text", () => {
      const rawHorizonDetail = "Internal server error XYZ-INTERNAL-9988";
      const classified = classifyHorizonError(
        { status: 500, detail: rawHorizonDetail, extras: {} },
        "server_error"
      );
      const pd = horizonToProblemDetails(classified);
      // The raw Horizon message must not appear in the envelope
      expect(pd.detail).not.toContain("XYZ-INTERNAL-9988");
      expect(pd.title).not.toContain("XYZ-INTERNAL-9988");
    });

    it("horizonToProblemDetails accepts instance and extensions options", () => {
      const classified = classifyHorizonError({ status: 404, detail: "nf", extras: {} }, "not_found");
      const pd = horizonToProblemDetails(classified, {
        instance: "/tools/balance-viewer",
        extensions: { network: "mainnet" },
      });
      expect(pd.instance).toBe("/tools/balance-viewer");
      expect(pd.extensions?.network).toBe("mainnet");
    });
  });

  describe("failure path: RPC bridge adapter", () => {
    it("rpcToProblemDetails maps every standard JSON-RPC error code to a valid envelope", () => {
      const rpcCodes = [
        RPC_STANDARD_CODES.PARSE_ERROR,
        RPC_STANDARD_CODES.INVALID_REQUEST,
        RPC_STANDARD_CODES.METHOD_NOT_FOUND,
        RPC_STANDARD_CODES.INVALID_PARAMS,
        RPC_STANDARD_CODES.INTERNAL_ERROR,
      ];

      for (const rpcCode of rpcCodes) {
        const classified = classifyRpcError({ code: rpcCode, message: "err" });
        const pd = rpcToProblemDetails(classified);
        assertValidProblemDetails(pd, `rpc:${rpcCode}`);
      }
    });

    it("rpcToProblemDetails maps a transport-level timeout to a retryable envelope", () => {
      const classified = classifyRpcTransportError("timeout");
      const pd = rpcToProblemDetails(classified);
      expect(pd.retryable).toBe(true);
      expect(pd.code).toBe("rpc_timeout");
    });

    it("rpcToProblemDetails maps a network unavailable transport error to a retryable envelope", () => {
      const classified = classifyRpcTransportError("network_unavailable");
      const pd = rpcToProblemDetails(classified);
      expect(pd.retryable).toBe(true);
      expect(pd.code).toBe("rpc_network_unavailable");
    });

    it("rpcToProblemDetails accepts instance and extensions", () => {
      const classified = classifyRpcError({
        code: RPC_STANDARD_CODES.INVALID_PARAMS,
        message: "bad params",
      });
      const pd = rpcToProblemDetails(classified, {
        instance: "/tools/soroban-decoder",
        extensions: { method: "simulateTransaction" },
      });
      expect(pd.instance).toBe("/tools/soroban-decoder");
      expect(pd.extensions?.method).toBe("simulateTransaction");
    });
  });

  // ─── Retry path ─────────────────────────────────────────────────────────────

  describe("retry path: retryable codes and idempotent reads", () => {
    it("isProblemRetryable is consistent with the registry retryable field", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        const def = getProblemDefinition(code);
        expect(isProblemRetryable(code)).toBe(def.retryable);
      }
    });

    it("problemDetailsFromCode is idempotent: same code produces the same envelope shape", () => {
      const pd1 = problemDetailsFromCode("horizon_rate_limited");
      const pd2 = problemDetailsFromCode("horizon_rate_limited");

      expect(pd1.type).toBe(pd2.type);
      expect(pd1.code).toBe(pd2.code);
      expect(pd1.status).toBe(pd2.status);
      expect(pd1.retryable).toBe(pd2.retryable);
      expect(pd1.hint).toBe(pd2.hint);
    });

    it("PROBLEM_CODES is a pure data structure: no cross-code mutation", () => {
      const def1 = getProblemDefinition("account_not_found");
      const def2 = getProblemDefinition("validation_error");

      // Accessing one definition must not change another
      expect(def1.code).toBe("account_not_found");
      expect(def2.code).toBe("validation_error");
    });
  });

  // ─── Stability contract ──────────────────────────────────────────────────────

  describe("stability contract: no code may be removed", () => {
    // This list mirrors the `ProblemCode` union exactly.
    // If a code is removed from PROBLEM_CODES, the lookup will throw or produce undefined.
    const ALL_CODES: ProblemCode[] = [
      // Validation
      "validation_error",
      "invalid_address",
      "invalid_amount",
      "invalid_asset_code",
      "missing_required_field",
      // Stellar account
      "account_not_found",
      "account_unfunded",
      "account_merge_ineligible",
      // Stellar asset / trustline
      "asset_not_found",
      "trustline_missing",
      "trustline_limit_exceeded",
      "trustline_no_issuer",
      // Stellar transaction
      "transaction_not_found",
      "transaction_malformed",
      "transaction_failed",
      "sequence_mismatch",
      "insufficient_fee",
      "precondition_failed",
      // Soroban
      "soroban_simulation_failed",
      "soroban_invocation_failed",
      "soroban_resource_limit_exceeded",
      "soroban_contract_not_found",
      "xdr_decode_error",
      "xdr_encode_error",
      // Horizon transport
      "horizon_not_found",
      "horizon_rate_limited",
      "horizon_bad_request",
      "horizon_server_error",
      "horizon_network_unavailable",
      "horizon_timeout",
      "horizon_unknown",
      // Soroban RPC transport
      "rpc_parse_error",
      "rpc_invalid_request",
      "rpc_method_not_found",
      "rpc_invalid_params",
      "rpc_server_error",
      "rpc_network_unavailable",
      "rpc_timeout",
      "rpc_unknown",
      // Internal
      "internal_error",
    ];

    it("every code in the ProblemCode union is present in PROBLEM_CODES", () => {
      for (const code of ALL_CODES) {
        expect(PROBLEM_CODES, `${code} must be in PROBLEM_CODES`).toHaveProperty(code);
      }
    });

    it("PROBLEM_CODES contains no extra undocumented codes", () => {
      const registryKeys = new Set(Object.keys(PROBLEM_CODES));
      const unionKeys = new Set(ALL_CODES);
      for (const key of registryKeys) {
        expect(unionKeys.has(key as ProblemCode), `unexpected code: ${key}`).toBe(true);
      }
    });

    it("every code's type URI contains a stable slug without underscores", () => {
      for (const code of ALL_CODES) {
        const def = getProblemDefinition(code);
        expect(def.type).not.toContain("_");
        expect(def.type).toMatch(/^https:\/\/utix\.dev\/problems\/[a-z][a-z0-9-]*$/);
      }
    });

    it("validation codes all have status 400", () => {
      const validationCodes: ProblemCode[] = [
        "validation_error",
        "invalid_address",
        "invalid_amount",
        "invalid_asset_code",
        "missing_required_field",
      ];
      for (const code of validationCodes) {
        expect(getProblemDefinition(code).status, code).toBe(400);
      }
    });

    it("not-found codes have status 404", () => {
      const notFoundCodes: ProblemCode[] = [
        "account_not_found",
        "asset_not_found",
        "trustline_no_issuer",
        "transaction_not_found",
        "soroban_contract_not_found",
        "horizon_not_found",
        "rpc_method_not_found",
      ];
      for (const code of notFoundCodes) {
        expect(getProblemDefinition(code).status, code).toBe(404);
      }
    });

    it("server-error transport codes have status 503 or 504", () => {
      const transportErrorCodes: ProblemCode[] = [
        "horizon_server_error",
        "horizon_network_unavailable",
        "rpc_server_error",
        "rpc_network_unavailable",
      ];
      for (const code of transportErrorCodes) {
        expect([503, 504], `${code} should be 503 or 504`).toContain(
          getProblemDefinition(code).status
        );
      }
    });
  });

  // ─── Edge cases and recovery ─────────────────────────────────────────────────

  describe("edge cases and recovery documentation", () => {
    it("correlationId round-trips through horizon bridge without modification", () => {
      const id = "550e8400-e29b-41d4-a716-446655440000";
      const classified = classifyHorizonError({ status: 503, detail: "err", extras: {} }, "server_error", id);
      const pd = horizonToProblemDetails(classified);
      expect(pd.correlationId).toBe(id);
    });

    it("extensions is a plain object — not mutated by problemDetailsFromCode", () => {
      const ext = { network: "testnet" };
      const pd = problemDetailsFromCode("account_not_found", { extensions: ext });
      // Modifying the returned envelope does not affect the input object reference
      (pd.extensions as Record<string, unknown>)["injected"] = true;
      expect(ext).not.toHaveProperty("injected");
    });

    it("getProblemDefinition returns a frozen view: each call produces the same object reference", () => {
      const def1 = getProblemDefinition("internal_error");
      const def2 = getProblemDefinition("internal_error");
      expect(def1).toBe(def2); // same const reference from the registry
    });

    it("retryable transport codes are a subset of codes with status >= 500 or 429", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        if (isProblemRetryable(code)) {
          const status = getProblemDefinition(code).status;
          expect([429, 500, 503, 504], `${code} retryable with status ${status}`).toContain(status);
        }
      }
    });

    it("non-retryable codes are only surfaced for 4xx client errors or final states", () => {
      for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
        if (!isProblemRetryable(code)) {
          const status = getProblemDefinition(code).status;
          // Non-retryable codes are either 4xx or a 500 that is not transient
          expect(status, `${code} non-retryable with status ${status}`).toBeGreaterThanOrEqual(400);
        }
      }
    });
  });
});
