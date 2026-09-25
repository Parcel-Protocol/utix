import { describe, expect, it } from "vitest";
import { decodeEnvelope } from "@/features/transaction-decoder/lib/transactionDecoder";

describe("decodeEnvelope", () => {
  it("rejects invalid xdr", () => {
    const res = decodeEnvelope({ xdr: "invalid-xdr" }, "testnet");
    expect(res.ok).toBe(false);
  });
});
