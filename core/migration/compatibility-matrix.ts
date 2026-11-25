export type StorageSchemaVersion = "v1" | "v2";

export interface SchemaCompatibilityFixture {
  readonly from: StorageSchemaVersion;
  readonly to: StorageSchemaVersion;
  readonly forwardSupported: boolean;
  readonly rollbackSupported: boolean;
  readonly stableFields: readonly string[];
  readonly migrationKind: "noop" | "upgrade" | "downgrade";
}

export const SCHEMA_COMPATIBILITY_MATRIX: readonly SchemaCompatibilityFixture[] = Object.freeze([
  Object.freeze({
    from: "v1",
    to: "v1",
    forwardSupported: true,
    rollbackSupported: true,
    stableFields: Object.freeze(["id", "kind", "state", "correlationId", "payload"]),
    migrationKind: "noop"
  }),
  Object.freeze({
    from: "v1",
    to: "v2",
    forwardSupported: true,
    rollbackSupported: true,
    stableFields: Object.freeze(["id", "kind", "state", "correlationId", "payload"]),
    migrationKind: "upgrade"
  }),
  Object.freeze({
    from: "v2",
    to: "v1",
    forwardSupported: true,
    rollbackSupported: true,
    stableFields: Object.freeze(["id", "kind", "state", "correlationId", "payload"]),
    migrationKind: "downgrade"
  }),
  Object.freeze({
    from: "v2",
    to: "v2",
    forwardSupported: true,
    rollbackSupported: true,
    stableFields: Object.freeze(["id", "kind", "state", "correlationId", "payload"]),
    migrationKind: "noop"
  })
] as const);

export function compatibilityFor(
  from: StorageSchemaVersion,
  to: StorageSchemaVersion
): SchemaCompatibilityFixture | undefined {
  return SCHEMA_COMPATIBILITY_MATRIX.find((entry) => entry.from === from && entry.to === to);
}
