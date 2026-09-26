import { describe, expect, it } from "vitest";
import path from "node:path";
import { findFeatureBoundaryViolations } from "../../scripts/check-feature-boundaries.mjs";

const fixtureRoot = path.resolve(process.cwd(), "scripts/__tests__/fixtures/boundaries");

describe("feature-slice import boundaries", () => {
  it("detects alias and deep-relative imports into another slice while allowing core", async () => {
    const violations = await findFeatureBoundaryViolations(fixtureRoot);
    expect(violations.map(({ owner, target }) => `${owner}->${target}`)).toEqual([
      "alpha->beta",
      "alpha->beta"
    ]);
    expect(violations.some(({ specifier }) => specifier === "@/core/result/result")).toBe(false);
  });
});
