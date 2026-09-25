import { describe, expect, it } from "vitest";
import { runPathPaymentInspector } from "@/features/path-payment-inspector/lib/pathPaymentInspector";
import { withMswHandlers } from "@/core/testing/msw";
import { handlers, poolOnlyHandler } from "@/features/path-payment-inspector/msw/handlers";
import { accountId, issuerId } from "@/features/path-payment-inspector/fixtures/pathPaymentInspector.fixture";

const server = withMswHandlers(...handlers);

describe("runPathPaymentInspector", () => {
  it("reads offers and preserves partial-fill state and exact price", async () => {
    const result = await runPathPaymentInspector({ view: "offers", account: accountId, limit: 200 }, "testnet");
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.offers[0]?.filled).toBe(true);
    expect(result.ok && result.value.offers[0]?.priceDecimal).toBe("0.000000000000000001");
  });

  it("reads a three-hop strict-send path", async () => {
    const result = await runPathPaymentInspector({ view: "paths", mode: "strict-send", source: { type: "native" }, destination: { type: "credit", code: "USDC", issuer: issuerId }, amount: "10" }, "testnet");
    expect(result.ok && result.value.paths[0]?.hops).toHaveLength(3);
  });

  it("distinguishes a liquidity-pool-only path", async () => {
    server.use(poolOnlyHandler);
    const result = await runPathPaymentInspector({ view: "paths", mode: "strict-receive", source: { type: "native" }, destination: { type: "credit", code: "USDC", issuer: issuerId }, amount: "9.9" }, "testnet");
    expect(result.ok && result.value.paths[0]?.hops[0]?.kind).toBe("liquidity_pool");
  });
});
