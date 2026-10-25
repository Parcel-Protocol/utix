import { describe, expect, it } from "vitest";
import { runScvalCodec } from "@/features/scval-codec/lib/scvalCodec";

describe("runScvalCodec", () => {
  it("encodes and decodes a typed integer", async () => {
    const result = await runScvalCodec({ value: '{"type":"u128","value":"42"}' }, "testnet");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.json).toEqual({ type: "u128", value: "42" });
  });
});
