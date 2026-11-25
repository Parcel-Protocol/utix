import { describe, expect, it } from "vitest";
import {
  archiveAuthorizedRecord,
  canAccessRecord,
  hideRecord,
  listAuthorizedRecords,
  readAuthorizedRecord,
  readAuthorizedRecordSync,
  restoreAuthorizedRecord,
  unhideRecord,
  type AuthorizedRecord,
  type AuthorizedRecordStore,
  type RecordActor
} from "../authorized-records";

function createMockStore<T>(initialRecords: AuthorizedRecord<T>[] = []): AuthorizedRecordStore<T> {
  const map = new Map<string, AuthorizedRecord<T>>();
  for (const r of initialRecords) map.set(r.id, r);

  return {
    read: (id) => map.get(id),
    write: (record) => {
      map.set(record.id, record);
    },
    list: (filter) => {
      const records = Array.from(map.values());
      if (!filter?.visibility) return records;
      return records.filter((r) => r.visibility === filter.visibility);
    }
  };
}

describe("authorized records access & lifecycle (#435)", () => {
  const viewerActor: RecordActor = { id: "user-1", role: "viewer" };
  const ownerActor: RecordActor = { id: "user-owner", role: "viewer" };
  const maintainerActor: RecordActor = { id: "maint-1", role: "maintainer" };
  const adminActor: RecordActor = { id: "admin-1", role: "admin" };
  const anonymousActor: RecordActor = { id: "anon", role: "anonymous" };

  const testRecord: AuthorizedRecord<{ name: string; secretData: string }> = {
    id: "rec-100",
    schemaVersion: 1,
    visibility: "active",
    ownerId: "user-owner",
    readers: ["user-1"],
    value: { name: "Resource Alpha", secretData: "vault-pass-xyz" }
  };

  describe("normal path", () => {
    it("allows active record reads by authorized owner, listed reader, and maintainer", () => {
      const store = createMockStore([testRecord]);

      const resOwner = readAuthorizedRecordSync(store, "rec-100", ownerActor);
      expect(resOwner.ok).toBe(true);

      const resViewer = readAuthorizedRecordSync(store, "rec-100", viewerActor);
      expect(resViewer.ok).toBe(true);

      const resMaint = readAuthorizedRecordSync(store, "rec-100", maintainerActor);
      expect(resMaint.ok).toBe(true);
    });

    it("allows maintainer to hide, unhide, archive, and restore records", () => {
      const store = createMockStore([testRecord]);

      const hideRes = hideRecord(store, "rec-100", maintainerActor);
      expect(hideRes.ok).toBe(true);
      expect(store.read("rec-100")?.visibility).toBe("hidden");

      const unhideRes = unhideRecord(store, "rec-100", maintainerActor);
      expect(unhideRes.ok).toBe(true);
      expect(store.read("rec-100")?.visibility).toBe("active");

      const archiveRes = archiveAuthorizedRecord(store, "rec-100", maintainerActor);
      expect(archiveRes.ok).toBe(true);
      expect(store.read("rec-100")?.visibility).toBe("archived");

      const restoreRes = restoreAuthorizedRecord(store, "rec-100", maintainerActor);
      expect(restoreRes.ok).toBe(true);
      expect(store.read("rec-100")?.visibility).toBe("active");
    });
  });

  describe("failure & non-disclosure path", () => {
    it("safely non-discloses hidden records to standard viewers as record_not_found", () => {
      const hiddenRecord: AuthorizedRecord<string> = {
        id: "rec-hidden",
        schemaVersion: 1,
        visibility: "hidden",
        ownerId: "user-owner",
        value: "confidential"
      };
      const store = createMockStore([hiddenRecord]);

      // Standard viewer should get record_not_found to prevent resource existence probing
      const viewerRes = readAuthorizedRecordSync(store, "rec-hidden", viewerActor);
      expect(viewerRes.ok).toBe(false);
      if (!viewerRes.ok) {
        expect(viewerRes.code).toBe("record_not_found");
      }

      // Anonymous actor also receives record_not_found
      const anonRes = readAuthorizedRecordSync(store, "rec-hidden", anonymousActor);
      expect(anonRes.ok).toBe(false);
      if (!anonRes.ok) {
        expect(anonRes.code).toBe("record_not_found");
      }

      // Maintainer can read hidden record
      const maintRes = readAuthorizedRecordSync(store, "rec-hidden", maintainerActor);
      expect(maintRes.ok).toBe(true);
    });

    it("rejects unauthorized archive read requests with record_archived", () => {
      const archivedRecord: AuthorizedRecord<string> = {
        id: "rec-arch",
        schemaVersion: 1,
        visibility: "archived",
        ownerId: "user-owner",
        value: "old-archive-data"
      };
      const store = createMockStore([archivedRecord]);

      const res = readAuthorizedRecordSync(store, "rec-arch", viewerActor);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("record_archived");
      }
    });

    it("rejects illegal state transitions", () => {
      const archivedRecord: AuthorizedRecord<string> = {
        id: "rec-arch",
        schemaVersion: 1,
        visibility: "archived",
        ownerId: "user-owner",
        value: "old-archive-data"
      };
      const store = createMockStore([archivedRecord]);

      // Cannot hide an already archived record directly
      const hideRes = hideRecord(store, "rec-arch", maintainerActor);
      expect(hideRes.ok).toBe(false);
      if (!hideRes.ok) {
        expect(hideRes.code).toBe("invalid_state_transition");
      }
    });
  });

  describe("authorization & permission grants", () => {
    it("allows specialized actor with records:read_hidden permission to read hidden records", () => {
      const hiddenRecord: AuthorizedRecord<string> = {
        id: "rec-hidden",
        schemaVersion: 1,
        visibility: "hidden",
        ownerId: "user-owner",
        value: "special-hidden"
      };
      const store = createMockStore([hiddenRecord]);

      const auditActor: RecordActor = {
        id: "auditor-1",
        role: "viewer",
        permissions: ["records:read_hidden"]
      };

      const res = readAuthorizedRecordSync(store, "rec-hidden", auditActor);
      expect(res.ok).toBe(true);
    });

    it("allows actor with records:read_archived to read archived records", () => {
      const archivedRecord: AuthorizedRecord<string> = {
        id: "rec-arch",
        schemaVersion: 1,
        visibility: "archived",
        ownerId: "user-owner",
        value: "archived-audit"
      };
      const store = createMockStore([archivedRecord]);

      const complianceActor: RecordActor = {
        id: "compliance-1",
        role: "viewer",
        permissions: ["records:read_archived"]
      };

      const res = readAuthorizedRecordSync(store, "rec-arch", complianceActor);
      expect(res.ok).toBe(true);
    });

    it("lists only records the actor has permission to see", () => {
      const records: AuthorizedRecord<string>[] = [
        { id: "1", schemaVersion: 1, visibility: "active", ownerId: "user-1", value: "active-1" },
        { id: "2", schemaVersion: 1, visibility: "hidden", ownerId: "user-2", value: "hidden-2" },
        { id: "3", schemaVersion: 1, visibility: "archived", ownerId: "user-3", value: "archived-3" }
      ];
      const store = createMockStore(records);

      const viewerItems = listAuthorizedRecords(store, viewerActor);
      expect(viewerItems.map((r) => r.id)).toEqual(["1"]);

      const maintainerItems = listAuthorizedRecords(store, maintainerActor);
      expect(maintainerItems.map((r) => r.id)).toEqual(["1", "2", "3"]);
    });
  });

  describe("retry & resilience path", () => {
    it("retries transient store read failures up to maxRetries", async () => {
      let callCount = 0;
      const failingStore: AuthorizedRecordStore<string> = {
        read: (id) => {
          callCount++;
          if (callCount < 3) {
            throw new Error("transient storage contention");
          }
          return {
            id,
            schemaVersion: 1,
            visibility: "active",
            ownerId: "user-owner",
            value: "recovered-after-retry"
          };
        },
        write: () => {}
      };

      const res = await readAuthorizedRecord(failingStore, "rec-flake", maintainerActor, {
        maxRetries: 3,
        retryDelayMs: 2
      });

      expect(res.ok).toBe(true);
      expect(callCount).toBe(3);
    });

    it("returns storage_contention_exhausted when retries are exceeded", async () => {
      const alwaysFailingStore: AuthorizedRecordStore<string> = {
        read: () => {
          throw new Error("permanent lock");
        },
        write: () => {}
      };

      const res = await readAuthorizedRecord(alwaysFailingStore, "rec-fail", maintainerActor, {
        maxRetries: 2,
        retryDelayMs: 1
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("storage_contention_exhausted");
      }
    });
  });
});
