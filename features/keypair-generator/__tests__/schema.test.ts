import { describe, expect, it } from "vitest";
import { parseKeypairGeneratorInput } from "@/features/keypair-generator/schema";

describe("parseKeypairGeneratorInput", () => {
  it("accepts an empty form because generation has no input", () => {
    expect(parseKeypairGeneratorInput("   ")).toEqual({ ok: true, value: {} });
  });
});
