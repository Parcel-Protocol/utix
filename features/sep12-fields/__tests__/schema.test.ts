import { describe, expect, it } from "vitest";
import { parseSep12FieldsInput } from "@/features/sep12-fields/schema";

describe("parseSep12FieldsInput", () => {
  it("rejects empty input", () => {
    const result = parseSep12FieldsInput("   ");
    expect(result).toEqual({ ok: false, code: "empty_input" });
  });

  it("normalises surrounding whitespace", () => {
    const result = parseSep12FieldsInput("  example  ");
    expect(result.ok && result.value.value).toBe("example");
  });
});
