import { describe, it, expect } from "vitest";
import {
  generateExplorerLinks,
  parseExplorerLinksInput,
} from "@/features/explorer-links/lib";

describe("explorer-links", () => {
  describe("parseExplorerLinksInput", () => {
    it("rejects empty input", () => {
      const result = parseExplorerLinksInput("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("empty_input");
      }
    });

    it("accepts valid input", () => {
      const result = parseExplorerLinksInput("12345");
      expect(result.ok).toBe(true);
    });
  });

  describe("generateExplorerLinks", () => {
    it("identifies ledger sequences", () => {
      const result = generateExplorerLinks({
        identifier: "12345",
        network: "mainnet",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe("ledger");
        expect(result.value.links.length).toBeGreaterThan(0);
      }
    });

    it("identifies transaction hashes", () => {
      const result = generateExplorerLinks({
        identifier: "a".repeat(64),
        network: "mainnet",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe("transaction");
      }
    });

    it("rejects unknown format", () => {
      const result = generateExplorerLinks({
        identifier: "invalid@data$format",
        network: "mainnet",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("unknown_identifier");
      }
    });

    it("generates testnet links", () => {
      const result = generateExplorerLinks({
        identifier: "12345",
        network: "testnet",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.links[0].url).toContain("testnet");
      }
    });
  });
});
