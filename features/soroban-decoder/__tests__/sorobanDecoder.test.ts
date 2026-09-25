import { describe, expect, it } from "vitest";
import { decodeScVal, decodeSorobanXdr } from "@/features/soroban-decoder/lib/sorobanDecoder";
import { xdr } from "@stellar/stellar-sdk";

describe("decodeScVal", () => {
  it("decodes boolean ScVal", () => {
    const val = xdr.ScVal.scvBool(true);
    const node = decodeScVal(val);
    expect(node.type).toBe("Bool");
    expect(node.value).toBe("true");
  });

  it("handles malformed XDR input", () => {
    const res = decodeSorobanXdr({ xdr: "invalid" }, "testnet");
    expect(res.ok).toBe(false);
  });
});
