import { describe, it, expect } from "vitest";
import { validateContractAddress } from "@/features/soroban-spec-viewer/lib";

describe("soroban-spec-viewer", () => {
  describe("validateContractAddress", () => {
    it("rejects empty input", () => {
      const result = validateContractAddress("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("empty_input");
      }
    });

    it("rejects non-C addresses", () => {
      const result = validateContractAddress("G" + "A".repeat(55));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_address");
      }
    });

    it("rejects addresses with wrong length", () => {
      const result = validateContractAddress("C" + "A".repeat(40));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_address");
      }
    });

    it("accepts valid C... addresses", () => {
      const validAddress = "C" + "A".repeat(55);
      const result = validateContractAddress(validAddress);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(validAddress);
      }
    });
  });
});
