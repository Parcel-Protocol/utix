import { withMswHandlers, http, HttpResponse } from "@/core/testing";
import { sorobanRpcHandlers, sorobanRpcMethod } from "@/core/testing/sorobanRpcHandlers";
import { describe, it, expect } from "vitest";

describe("sorobanRpcHandlers", () => {
  it("provides handlers for Soroban RPC methods", () => {
    const handlers = sorobanRpcHandlers();

    expect(handlers).toBeInstanceOf(Array);
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("handles simulateTransaction method", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.result).toBeDefined();
    expect(data.result.events).toBeDefined();
  });

  it("handles getLedgerEntries method", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.result.entries).toBeDefined();
  });

  it("handles getContractData method", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getContractData",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.result.xdr).toBeDefined();
  });

  it("returns error for unknown method", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "unknownMethod",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32601);
  });

  it("accepts custom fixtures", async () => {
    const customFixture = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { custom: "data" }
    };

    const server = withMswHandlers(
      ...sorobanRpcHandlers({
        fixtures: {
          simulateTransaction: customFixture
        }
      })
    );

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.result.custom).toBe("data");
  });

  it("preserves request id in response", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "custom-id",
        method: "simulateTransaction",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.id).toBe("custom-id");
  });

  it("sorobanRpcMethod creates handler for specific method", async () => {
    const customResponse = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { test: "value" }
    };

    const handler = sorobanRpcMethod("testMethod", customResponse);

    const server = withMswHandlers(handler);

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "testMethod",
        params: {}
      })
    });

    const data = await response.json();

    expect(data.result.test).toBe("value");
  });

  it("handles missing method in request", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1
      })
    });

    const data = await response.json();

    expect(data.error).toBeDefined();
  });

  it("handles parse errors gracefully", async () => {
    const server = withMswHandlers(...sorobanRpcHandlers());

    const response = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "invalid json"
    });

    const data = await response.json();

    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32700);
  });
});
