import { describe, expect, it } from "vitest";
import { runKeypairGenerator } from "@/features/keypair-generator/lib/keypairGenerator";

describe("runKeypairGenerator", () => {
  it("generates a testnet keypair without network access", async () => {
    const result = await runKeypairGenerator({}, "testnet");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.publicKey).toMatch(/^G/);
  });
});
