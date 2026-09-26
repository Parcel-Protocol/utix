import { describe, expect, it } from "vitest";
import { renderManifests } from "../../scripts/generate-registry.mjs";
import { assertGeneratedRegistryVersion } from "../../scripts/verify-features.mjs";

describe("generated registry schema", () => {
  it("embeds the current schema version", () => {
    expect(renderManifests([])).toContain("generatedRegistrySchemaVersion = 1");
  });

  it("rejects an old schema with upgrade instructions", () => {
    expect(() => assertGeneratedRegistryVersion("export const generatedRegistrySchemaVersion = 0", "old.ts"))
      .toThrow(/old\.ts uses schema v0.*Run npm run registry/);
  });
});
