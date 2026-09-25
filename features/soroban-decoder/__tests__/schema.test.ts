import { describe, expect, it } from "vitest";
import { parseSorobanDecoderInput } from "@/features/soroban-decoder/schema";

describe("parseSorobanDecoderInput", () => {
  it("rejects empty input", () => {
    const res = parseSorobanDecoderInput(" ");
    expect(res.ok).toBe(false);
  });

  it("trims valid input", () => {
    const res = parseSorobanDecoderInput(" AAA ");
    expect(res.ok).toBe(true);
  });
});
