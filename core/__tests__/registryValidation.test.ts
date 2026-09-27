import { describe, it, expect, vi } from "vitest";
// @ts-expect-error script module without d.ts
import { generateRegistry, REGISTRY_SCHEMA_VERSION } from "../../scripts/generate-registry.mjs";

describe("generated registry determinism validation", () => {
  it("exports current schema version", () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(1);
  });

  it("generateRegistry with check=true passes when registry is up to date", async () => {
    const result = await generateRegistry({ check: true });
    expect(result.changed).toBe(false);
    expect(result.slugs.length).toBeGreaterThan(0);
  });

  it("generateRegistry with check=false regenerates registry", async () => {
    const result = await generateRegistry({ check: false });
    expect(result.changed).toBe(true);
    expect(result.slugs.length).toBeGreaterThan(0);
  });
});
