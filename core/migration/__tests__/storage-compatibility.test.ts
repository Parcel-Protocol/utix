import { describe, expect, it } from "vitest";
import legacy from "./fixtures/storage-v1.json";
import current from "./fixtures/storage-v2.json";
import {
  checkStorageCompatibility,
  downgradeV2ToV1,
  executeStorageSchemaMigration,
  StorageV1ToV2Migration,
  type StorageRecordV1,
  type StorageRecordV2
} from "../storage-schema";

describe("versioned storage compatibility fixtures (#352)", () => {
  it("accepts the documented legacy V1 shape and upgrades it without changing business fields", () => {
    expect(checkStorageCompatibility(legacy).compatible).toBe(true);
    const [upgraded] = StorageV1ToV2Migration.apply(legacy as StorageRecordV1[]).transformed;
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.payload).toEqual(legacy[0].payload);
    expect(upgraded.migrationMeta?.migratedFrom).toBe(1);
  });

  it("preserves an already-current record on retry and can downgrade it for rollback", () => {
    expect(checkStorageCompatibility(current).compatible).toBe(true);
    const record = current[0] as StorageRecordV2;
    expect(StorageV1ToV2Migration.apply([record]).transformed[0]).toBe(record);
    expect(downgradeV2ToV1(record).payload).toEqual(record.payload);
  });

  it("rejects malformed legacy and incomplete V2 fixtures before mutation", () => {
    const invalid = [{ ...legacy[0], id: "" }, { id: "broken-v2", schemaVersion: 2 }];
    const check = checkStorageCompatibility(invalid);
    expect(check.compatible).toBe(false);
    expect(check.invalidRecords).toContain("missing_id");
    expect(check.invalidRecords).toContain("broken-v2");
  });

  it("keeps preflight, authorization, failure recovery, and retries explicit", async () => {
    const dryRun = await executeStorageSchemaMigration(legacy as StorageRecordV1[], {
      actor: { kind: "maintainer", id: "fixture-runner" },
      dryRun: true
    });
    expect(dryRun.ok).toBe(true);
    if (dryRun.ok) expect(dryRun.value.dryRun).toBe(true);

    const denied = await executeStorageSchemaMigration(legacy as StorageRecordV1[], {
      actor: { kind: "user", id: "fixture-user" }
    });
    expect(denied).toMatchObject({ ok: false, code: "permission_denied" });

    const failed = await executeStorageSchemaMigration(legacy as StorageRecordV1[], {
      actor: { kind: "maintainer", id: "fixture-runner" },
      simulateFailure: true,
      autoRollbackOnFailure: true
    });
    expect(failed).toMatchObject({ ok: false, code: "migration_validation_failed" });

    const retry = StorageV1ToV2Migration.apply([
      ...(legacy as StorageRecordV1[]),
      ...(current as StorageRecordV2[])
    ]).transformed;
    expect(retry).toHaveLength(2);
    expect(retry[1]).toBe(current[0]);
  });
});
