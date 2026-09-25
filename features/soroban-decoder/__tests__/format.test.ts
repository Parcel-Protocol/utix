import { describe, expect, it } from "vitest";
import { formatSummary } from "@/features/soroban-decoder/lib/format";

describe("formatSummary", () => {
  it("trims value", () => {
    expect(formatSummary(" test ")).toBe("test");
  });
});
