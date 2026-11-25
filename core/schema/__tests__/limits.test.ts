import { describe, expect, it } from "vitest";
import {
  createInputLimiter,
  defaultInputLimiter,
  DEFAULT_MAX_COLLECTION_SIZE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_OBJECT_KEYS,
  DEFAULT_MAX_STRING_LENGTH,
  HARD_CEILING_MAX_BYTES
} from "../limits";

describe("Strict Input Size and Cardinality Limits (Issue #365)", () => {
  const limiter = defaultInputLimiter;

  describe("Normal Path: Inputs within Strict Bounds", () => {
    it("accepts valid primitive and structured inputs", () => {
      const payload = {
        name: "Testnet Ledger Query",
        addresses: ["GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"],
        config: {
          timeoutMs: 5000,
          retryCount: 3
        }
      };

      const result = limiter.enforceLimits(payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(payload);
    });

    it("accepts inputs with null or undefined safely", () => {
      expect(limiter.enforceLimits(null).ok).toBe(true);
      expect(limiter.enforceLimits(undefined).ok).toBe(true);
    });
  });

  describe("Failure Paths: Limit Violations", () => {
    it("rejects string inputs exceeding max string length", () => {
      const hugeString = "a".repeat(DEFAULT_MAX_STRING_LENGTH + 10);
      const res = limiter.enforceLimits(hugeString);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("string_too_long");
      expect(res.detail?.limitType).toBe("string_length");
    });

    it("rejects array cardinality exceeding maximum collection size", () => {
      const hugeArray = new Array(DEFAULT_MAX_COLLECTION_SIZE + 10).fill("item");
      const res = limiter.enforceLimits({ items: hugeArray });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("cardinality_exceeded");
      expect(res.detail?.actual).toBe(DEFAULT_MAX_COLLECTION_SIZE + 10);
    });

    it("rejects objects with excessive key counts", () => {
      const hugeObject: Record<string, number> = {};
      for (let i = 0; i < DEFAULT_MAX_OBJECT_KEYS + 5; i++) {
        hugeObject[`k_${i}`] = i;
      }

      const res = limiter.enforceLimits(hugeObject);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("object_key_limit_exceeded");
    });

    it("rejects deeply nested structures (JSON/AST bomb defense)", () => {
      // Build structure deeper than DEFAULT_MAX_DEPTH (16)
      let deep: any = { value: "leaf" };
      for (let i = 0; i < DEFAULT_MAX_DEPTH + 5; i++) {
        deep = { child: deep };
      }

      const res = limiter.enforceLimits(deep);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("nesting_depth_exceeded");
    });

    it("rejects prototype pollution attempts via dangerous keys", () => {
      const maliciousPayload = JSON.parse('{"__proto__": {"admin": true}}');
      const res = limiter.enforceLimits(maliciousPayload);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("disallowed_key_detected");
      expect(res.detail?.actual).toBe("__proto__");
    });
  });

  describe("Authorization Path: Elevated Limits", () => {
    it("allows maintainer to relax collection and payload limits up to ceiling", () => {
      const largeArray = new Array(800).fill("entry");
      const maintainerAuth = { actor: { kind: "maintainer", id: "ops-lead" } };

      const res = limiter.enforceLimits(
        { data: largeArray },
        { maxCollectionSize: 1000 },
        maintainerAuth
      );

      expect(res.ok).toBe(true);
    });

    it("rejects non-maintainer attempting to relax limits", () => {
      const userAuth = { actor: { kind: "user", id: "user-123" } };

      const res = limiter.enforceLimits(
        { data: ["ok"] },
        { maxCollectionSize: 1000 },
        userAuth
      );

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("unauthorized_override");
    });

    it("rejects maintainer override exceeding hard safety ceiling", () => {
      const maintainerAuth = { actor: { kind: "maintainer", id: "ops-lead" } };

      const res = limiter.enforceLimits(
        "large",
        { maxBytes: HARD_CEILING_MAX_BYTES + 500 },
        maintainerAuth
      );

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("payload_too_large");
      expect(res.detail?.limitType).toBe("hard_ceiling_bytes");
    });
  });

  describe("Retry & Recovery Path: Truncation & Batch Slicing", () => {
    it("sanitizes and truncates oversized arrays gracefully", () => {
      const oversized = {
        title: "Test",
        items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      };

      const result = limiter.sanitizeOrTruncate<typeof oversized>(oversized, {
        maxCollectionSize: 4
      });

      expect(result.truncated).toBe(true);
      expect(result.droppedItemsCount).toBe(6);
      expect(result.sanitized.items).toHaveLength(4);
    });

    it("sanitizes long strings with truncation indicator", () => {
      const oversized = {
        memo: "This is a very long memo string that needs to be truncated for storage"
      };

      const result = limiter.sanitizeOrTruncate<typeof oversized>(oversized, {
        maxStringLength: 10
      });

      expect(result.truncated).toBe(true);
      expect(result.truncatedStringsCount).toBe(1);
      expect(result.sanitized.memo).toContain("...[TRUNCATED]");
    });

    it("suggests chunking parameters for oversized cardinality", () => {
      const suggestion = limiter.suggestSlicing(1250, 500);
      expect(suggestion.recommendedBatchSize).toBe(500);
      expect(suggestion.totalChunks).toBe(3);
    });
  });
});

