import { describe, it, expect } from "vitest";
import { parseInput } from "@/features/soroban-fee-estimator/lib";

describe("soroban-fee-estimator", () => {
  describe("parseInput", () => {
    it("rejects empty input", () => {
      const result = parseInput("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("empty_input");
      }
    });

    it("accepts valid base64", () => {
      const result = parseInput("dGVzdA==");
      expect(result.ok).toBe(true);
    });

    it("defaults to mainnet", () => {
      const result = parseInput("dGVzdA==");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.network).toBe("mainnet");
      }
    });
  });
});
