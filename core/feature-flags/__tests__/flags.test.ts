import { afterEach, describe, expect, it } from "vitest";
import { featureFlagDefaults, isFeatureEnabled } from "@/core/feature-flags/flags";

const original = process.env.UTIX_FLAG_detailedFriendbotClassification;

afterEach(() => {
  if (original === undefined) delete process.env.UTIX_FLAG_detailedFriendbotClassification;
  else process.env.UTIX_FLAG_detailedFriendbotClassification = original;
});

describe("feature flags", () => {
  it("uses the compatibility-preserving default when configuration is missing", () => {
    delete process.env.UTIX_FLAG_detailedFriendbotClassification;
    expect(isFeatureEnabled("detailedFriendbotClassification")).toBe(true);
    expect(featureFlagDefaults().detailedFriendbotClassification).toBe(true);
  });

  it("supports explicit enable and emergency disable values", () => {
    process.env.UTIX_FLAG_detailedFriendbotClassification = "true";
    expect(isFeatureEnabled("detailedFriendbotClassification")).toBe(true);
    process.env.UTIX_FLAG_detailedFriendbotClassification = "0";
    expect(isFeatureEnabled("detailedFriendbotClassification")).toBe(false);
  });
});