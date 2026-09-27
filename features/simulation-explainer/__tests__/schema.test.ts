import { describe, expect, it } from "vitest";
import { parseSimulationExplainerInput } from "@/features/simulation-explainer/schema";

describe("parseSimulationExplainerInput", () => {
  it("rejects empty input", () => {
    const result = parseSimulationExplainerInput("   ");
    expect(result).toEqual({ ok: false, code: "empty_input" });
  });

  it("normalises surrounding whitespace", () => {
    const result = parseSimulationExplainerInput("  example  ");
    expect(result.ok && result.value.value).toBe("example");
  });
});
