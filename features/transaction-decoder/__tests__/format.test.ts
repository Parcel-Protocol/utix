import { describe, expect, it } from "vitest";
import { formatSummary } from "@/features/transaction-decoder/lib/format";

describe("formatSummary", () => {
  it("trims text", () => {
    expect(formatSummary(" test ")).toBe("test");
  });
});
