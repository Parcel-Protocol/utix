/**
 * Soroban RPC fixture generation utilities.
 *
 * This module provides helpers to generate valid XDR-encoded Soroban RPC response
 * fixtures using @stellar/stellar-sdk's XDR helpers. Fixtures should be generated
 * offline and checked into version control, never created in tests.
 *
 * Usage:
 * ```ts
 * import { generateSimulateTransactionFixture } from "@/core/testing/sorobanRpcFixtures";
 * const fixture = generateSimulateTransactionFixture({
 *   operations: [{ method: "transfer", amount: "100" }]
 * });
 * ```
 */

import { nativeToScVal } from "@stellar/stellar-sdk";

export interface SimulateTransactionFixtureOptions {
  events?: Array<{ type: string; data: unknown }>;
  resultError?: string;
  cost?: { cpuInsns: string; memBytes: string };
}

export interface GetLedgerEntriesFixtureOptions {
  entries?: Array<{ key: string; value: unknown }>;
}

export interface GetContractDataFixtureOptions {
  contractId: string;
  key: unknown;
  xdrVal?: string;
}

/**
 * Malformed JSON-RPC fixture presets for testing RPC boundary error handling.
 */
export const MALFORMED_RPC_PAYLOADS = {
  nonObjectString: '"unexpected string response"',
  nonObjectNumber: "12345",
  nonObjectArray: "[]",
  missingJsonRpc: JSON.stringify({ id: 1, result: {} }),
  wrongJsonRpcVersion: JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} }),
  bothResultAndError: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { status: "ok" },
    error: { code: -32603, message: "Internal conflict" }
  }),
  invalidIdType: JSON.stringify({ jsonrpc: "2.0", id: true, result: {} }),
  nullIdWithResult: JSON.stringify({ jsonrpc: "2.0", id: null, result: {} }),
  missingPayload: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
  invalidErrorObject: JSON.stringify({ jsonrpc: "2.0", id: 1, error: "not-an-object" }),
  missingErrorCode: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "no code" } })
} as const;

export type MalformedRpcType = keyof typeof MALFORMED_RPC_PAYLOADS;

/**
 * Generates deterministic malformed JSON-RPC fixtures for each failure shape.
 */
export function generateMalformedRpcFixture(type: MalformedRpcType): string {
  return MALFORMED_RPC_PAYLOADS[type];
}

/**
 * Generates a simulateTransaction response fixture with the given options.
 * The response includes proper XDR encoding for all values.
 */
export function generateSimulateTransactionFixture(
  options: SimulateTransactionFixtureOptions = {}
): string {
  const { events = [], resultError, cost = { cpuInsns: "1000", memBytes: "100" } } = options;

  const fixture = {
    jsonrpc: "2.0",
    id: "1",
    result: {
      error: resultError ?? null,
      events: events.map((e) => ({
        type: e.type,
        body: nativeToScVal(e.data, { type: "string" }).toXDR("base64")
      })),
      cost,
      latestLedger: 12345
    }
  };

  return JSON.stringify(fixture);
}

/**
 * Generates a getLedgerEntries response fixture.
 */
export function generateGetLedgerEntriesFixture(
  options: GetLedgerEntriesFixtureOptions = {}
): string {
  const { entries = [] } = options;

  const fixture = {
    jsonrpc: "2.0",
    id: "1",
    result: {
      entries: entries.map((e) => ({
        key: e.key,
        val: nativeToScVal(e.value, { type: "string" }).toXDR("base64"),
        lastModifiedLedgerSeq: 12345,
        liveUntilLedgerSeq: 12445
      })),
      latestLedger: 12345
    }
  };

  return JSON.stringify(fixture);
}

/**
 * Generates a getContractData response fixture.
 */
export function generateGetContractDataFixture(
  options: GetContractDataFixtureOptions
): string {
  const { xdrVal, key } = options;

  const fixture = {
    jsonrpc: "2.0",
    id: "1",
    result: {
      xdr: xdrVal ?? nativeToScVal(key, { type: "string" }).toXDR("base64"),
      latestLedger: 12345
    }
  };

  return JSON.stringify(fixture);
}

/**
 * Verifies a fixture by decoding and validating JSON-RPC and Soroban RPC constraints.
 */
export function verifyFixture(jsonString: string): { valid: boolean; error?: string } {
  try {
    const fixture = JSON.parse(jsonString);

    if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) {
      return { valid: false, error: "Fixture must be a JSON object" };
    }

    if (!fixture.jsonrpc || fixture.jsonrpc !== "2.0") {
      return { valid: false, error: "Invalid JSON-RPC version" };
    }

    if (
      fixture.id === undefined ||
      typeof fixture.id === "boolean" ||
      (typeof fixture.id !== "string" && typeof fixture.id !== "number" && fixture.id !== null)
    ) {
      return { valid: false, error: "Invalid JSON-RPC id" };
    }

    const hasResult = "result" in fixture;
    const hasError = "error" in fixture;

    if (hasResult && hasError) {
      return { valid: false, error: "Response cannot contain both result and error" };
    }

    if (!hasResult && !hasError) {
      return { valid: false, error: "Missing result or error field" };
    }

    if (hasResult && fixture.id === null) {
      return { valid: false, error: "Successful response cannot have null id" };
    }

    if (hasError) {
      if (
        typeof fixture.error !== "object" ||
        fixture.error === null ||
        !fixture.error.code
      ) {
        return { valid: false, error: "Error must have code field" };
      }
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: String(e) };
  }
}
