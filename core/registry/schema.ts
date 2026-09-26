export const FEATURE_REGISTRY_SCHEMA_VERSION = 1 as const;

export function assertFeatureRegistryVersion(
  actual: number,
  consumer: string
): asserts actual is typeof FEATURE_REGISTRY_SCHEMA_VERSION {
  if (actual !== FEATURE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `[registry] ${consumer} expects schema v${FEATURE_REGISTRY_SCHEMA_VERSION}, ` +
        `but the generated registry is v${actual}. Run npm run registry; if the shape changed, ` +
        `bump FEATURE_REGISTRY_SCHEMA_VERSION and document the migration.`
    );
  }
}
