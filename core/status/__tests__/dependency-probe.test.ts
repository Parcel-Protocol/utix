import { describe, expect, it } from "vitest";
import { probePublicDependencies } from "../dependency-probe";

describe("public dependency probes", () => {
  it("reports configured healthy and down providers without exposing responses", async () => {
    const urls: string[] = [];
    const response = await probePublicDependencies({
      horizonUrl: "https://horizon-testnet.stellar.org/",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org/",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        if (init?.method === "POST") return Response.json({ jsonrpc: "2.0", id: 1, result: { status: "healthy" } });
        return new Response(null, { status: 200 });
      }) as typeof fetch
    });
    expect(response).toEqual({ horizon: "healthy", soroban_rpc: "healthy" });
    expect(urls).toHaveLength(2);
  });
  it("never calls private or arbitrary hosts from misconfigured environment", async () => {
    let calls = 0;
    const result = await probePublicDependencies({
      horizonUrl: "http://localhost:3000/admin",
      sorobanRpcUrl: "https://example.test/something",
      fetchImpl: (async () => { calls++; return new Response(); }) as typeof fetch
    });
    expect(result).toEqual({ horizon: "degraded", soroban_rpc: "degraded" });
    expect(calls).toBe(0);
  });
  it("degrades on rate limiting, marks 5xx outages, and does not retry an unsafe URL", async () => {
    const result = await probePublicDependencies({
      horizonUrl: "https://horizon-testnet.stellar.org/",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org/",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(null, { status: init?.method === "POST" ? 503 : 429 })) as typeof fetch
    });
    expect(result).toEqual({ horizon: "degraded", soroban_rpc: "down" });
  });
});
