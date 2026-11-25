import { describe, expect, it } from "vitest";
import { compatibilityFor, SCHEMA_COMPATIBILITY_MATRIX } from "../compatibility-matrix";

describe("schema migration compatibility matrix", () => {
  it("covers same-version and cross-version v1/v2 paths", () => {
    expect(SCHEMA_COMPATIBILITY_MATRIX).toHaveLength(4);
    expect(compatibilityFor("v1", "v2")).toMatchObject({
      forwardSupported: true,
      rollbackSupported: true,
      migrationKind: "upgrade"
    });
    expect(compatibilityFor("v2", "v1")).toMatchObject({
      forwardSupported: true,
      rollbackSupported: true,
      migrationKind: "downgrade"
    });
  });

  it("identifies noops and protected business fields", () => {
    expect(compatibilityFor("v1", "v1")?.migrationKind).toBe("noop");
    expect(compatibilityFor("v2", "v2")?.migrationKind).toBe("noop");
    expect(compatibilityFor("v1", "v2")?.stableFields).toContain("payload");
  });
});
