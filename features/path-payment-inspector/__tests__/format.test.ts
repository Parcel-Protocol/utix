import { describe, expect, it } from "vitest";
import { formatRatio } from "@/features/path-payment-inspector/lib/format";

describe("formatRatio", () => {
  it("formats very small and very large ratios without float drift", () => {
    expect(formatRatio("1", "1000000000000000000")).toBe("0.000000000000000001");
    expect(formatRatio("1000000000000000000", "1")).toBe("1000000000000000000");
  });
});
