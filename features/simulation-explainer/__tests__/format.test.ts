import { describe, expect, it } from "vitest";
import { formatSummary } from "@/features/simulation-explainer/lib/format";

describe("formatSummary", () => {
  it("trims the value", () => {
    expect(formatSummary(" example ")).toBe("example");
  });
});
