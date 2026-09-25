import { describe, expect, it } from "vitest";
import { parseTransactionDecoderInput } from "@/features/transaction-decoder/schema";

describe("parseTransactionDecoderInput", () => {
  it("rejects empty input", () => {
    const res = parseTransactionDecoderInput("  ");
    expect(res.ok).toBe(false);
  });

  it("trims valid xdr", () => {
    const res = parseTransactionDecoderInput("  AAAA  ");
    expect(res.ok).toBe(true);
  });
});
