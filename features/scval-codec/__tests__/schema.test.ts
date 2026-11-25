import { describe, expect, it } from "vitest";
import { parseScvalCodecInput } from "@/features/scval-codec/schema";

describe("parseScvalCodecInput", () => {
  it("rejects empty input", () => {
    const result = parseScvalCodecInput("   ");
    expect(result).toEqual({ ok: false, code: "empty_input" });
  });

  it("normalises surrounding whitespace", () => {
    const result = parseScvalCodecInput("  example  ");
    expect(result.ok && result.value.value).toBe("example");
  });
});
