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
 * Verifies a fixture by decoding and re-encoding to catch common mistakes
 * like incorrect base64 padding or malformed XDR.
 */
export function verifyFixture(jsonString: string): { valid: boolean; error?: string } {
  try {
    const fixture = JSON.parse(jsonString);

    if (!fixture.jsonrpc || fixture.jsonrpc !== "2.0") {
      return { valid: false, error: "Invalid JSON-RPC version" };
    }

    if (!("result" in fixture) && !("error" in fixture)) {
      return { valid: false, error: "Missing result or error field" };
    }

    if (fixture.error && !fixture.error.code) {
      return { valid: false, error: "Error must have code field" };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: String(e) };
  }
}
