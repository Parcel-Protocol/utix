import {
  generateSimulateTransactionFixture,
  generateGetLedgerEntriesFixture,
  generateGetContractDataFixture,
  verifyFixture
} from "@/core/testing/sorobanRpcFixtures";
import { describe, it, expect } from "vitest";

describe("sorobanRpcFixtures", () => {
  describe("generateSimulateTransactionFixture", () => {
    it("generates a valid JSON-RPC response", () => {
      const fixture = generateSimulateTransactionFixture();
      const parsed = JSON.parse(fixture);

      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.result).toBeDefined();
      expect(parsed.id).toBeDefined();
    });

    it("includes events in response", () => {
      const fixture = generateSimulateTransactionFixture({
        events: [{ type: "transfer", data: "100" }]
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.events).toHaveLength(1);
      expect(parsed.result.events[0].type).toBe("transfer");
    });

    it("includes error in response when specified", () => {
      const fixture = generateSimulateTransactionFixture({
        resultError: "Insufficient balance"
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.error).toBe("Insufficient balance");
    });

    it("includes cost information", () => {
      const fixture = generateSimulateTransactionFixture({
        cost: { cpuInsns: "5000", memBytes: "500" }
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.cost.cpuInsns).toBe("5000");
      expect(parsed.result.cost.memBytes).toBe("500");
    });

    it("includes latestLedger", () => {
      const fixture = generateSimulateTransactionFixture();
      const parsed = JSON.parse(fixture);

      expect(parsed.result.latestLedger).toBeDefined();
      expect(typeof parsed.result.latestLedger).toBe("number");
    });
  });

  describe("generateGetLedgerEntriesFixture", () => {
    it("generates a valid JSON-RPC response", () => {
      const fixture = generateGetLedgerEntriesFixture();
      const parsed = JSON.parse(fixture);

      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.result).toBeDefined();
    });

    it("includes entries in response", () => {
      const fixture = generateGetLedgerEntriesFixture({
        entries: [{ key: "contract_1", value: "data" }]
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.entries).toHaveLength(1);
      expect(parsed.result.entries[0].key).toBe("contract_1");
      expect(parsed.result.entries[0].val).toBeDefined();
    });

    it("includes ledger metadata for each entry", () => {
      const fixture = generateGetLedgerEntriesFixture({
        entries: [{ key: "test", value: "data" }]
      });
      const parsed = JSON.parse(fixture);

      const entry = parsed.result.entries[0];
      expect(entry.lastModifiedLedgerSeq).toBeDefined();
      expect(entry.liveUntilLedgerSeq).toBeDefined();
    });

    it("handles empty entries list", () => {
      const fixture = generateGetLedgerEntriesFixture({ entries: [] });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.entries).toHaveLength(0);
    });
  });

  describe("generateGetContractDataFixture", () => {
    it("generates a valid JSON-RPC response", () => {
      const fixture = generateGetContractDataFixture({
        contractId: "ABC123",
        key: "data"
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.result).toBeDefined();
    });

    it("includes xdr value in response", () => {
      const fixture = generateGetContractDataFixture({
        contractId: "ABC123",
        key: "data"
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.xdr).toBeDefined();
      expect(typeof parsed.result.xdr).toBe("string");
    });

    it("uses provided xdrVal when specified", () => {
      const customXdr = "AAAADgAAAAA=";
      const fixture = generateGetContractDataFixture({
        contractId: "ABC123",
        key: "data",
        xdrVal: customXdr
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.xdr).toBe(customXdr);
    });

    it("includes latestLedger", () => {
      const fixture = generateGetContractDataFixture({
        contractId: "ABC123",
        key: "data"
      });
      const parsed = JSON.parse(fixture);

      expect(parsed.result.latestLedger).toBeDefined();
    });
  });

  describe("verifyFixture", () => {
    it("validates JSON-RPC version", () => {
      const invalid = JSON.stringify({ id: 1 });
      const result = verifyFixture(invalid);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("JSON-RPC");
    });

    it("validates result or error field exists", () => {
      const invalid = JSON.stringify({ jsonrpc: "2.0", id: 1 });
      const result = verifyFixture(invalid);

      expect(result.valid).toBe(false);
    });

    it("validates error has code field", () => {
      const invalid = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "test" }
      });
      const result = verifyFixture(invalid);

      expect(result.valid).toBe(false);
    });

    it("passes valid fixture with result", () => {
      const valid = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { test: "data" }
      });
      const result = verifyFixture(valid);

      expect(result.valid).toBe(true);
    });

    it("passes valid fixture with error", () => {
      const valid = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" }
      });
      const result = verifyFixture(valid);

      expect(result.valid).toBe(true);
    });

    it("returns error for invalid JSON", () => {
      const result = verifyFixture("not json");

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
