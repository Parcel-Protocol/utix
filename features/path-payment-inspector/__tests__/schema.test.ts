import { describe, expect, it } from "vitest";
import { parsePathPaymentInspectorInput } from "@/features/path-payment-inspector/schema";
import { accountId, issuerId } from "@/features/path-payment-inspector/fixtures/pathPaymentInspector.fixture";

describe("parsePathPaymentInspectorInput", () => {
  it("rejects empty input", () => {
    const result = parsePathPaymentInspectorInput("   ");
    expect(result).toEqual({ ok: false, code: "empty_input" });
  });

  it("accepts an offers query and normalises surrounding whitespace", () => {
    const result = parsePathPaymentInspectorInput(` {"view":"offers","account":"${accountId}"} `);
    expect(result.ok && result.value.view).toBe("offers");
  });

  it("rejects invalid assets and non-positive amounts", () => {
    const result = parsePathPaymentInspectorInput(JSON.stringify({ view: "paths", mode: "strict-send", source: "native", destination: { type: "credit", code: "USDC", issuer: issuerId }, amount: "0" }));
    expect(result).toEqual({ ok: false, code: "invalid_input" });
  });
});
