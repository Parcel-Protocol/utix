import { describe, expect, it } from "vitest";

import { generatedFeatures } from "@/core/registry/registry.generated";

describe("feature registry laziness", () => {
  it("exposes lazy loaders instead of eager panel modules", () => {
    expect(Array.isArray(generatedFeatures)).toBe(true);
    expect(generatedFeatures.length).toBeGreaterThan(0);
    expect(generatedFeatures[0]).toHaveProperty("load");
    expect(generatedFeatures[0]).not.toHaveProperty("Panel");
  });
});
