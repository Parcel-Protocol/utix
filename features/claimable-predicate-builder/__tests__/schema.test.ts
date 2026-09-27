import { describe, expect, it } from "vitest";
import { parseClaimablePredicateBuilderInput } from "@/features/claimable-predicate-builder/schema";

describe("parseClaimablePredicateBuilderInput", () => {
  it("rejects empty input", () => {
    const result = parseClaimablePredicateBuilderInput("   ");
    expect(result).toEqual({ ok: false, code: "empty_input" });
  });

  it("normalises surrounding whitespace", () => {
    const result = parseClaimablePredicateBuilderInput("  example  ");
    expect(result.ok && result.value.value).toBe("example");
  });
});
