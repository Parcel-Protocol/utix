import { describe, expect, it } from "vitest";
import {
  analyzeConflict,
  applyConcurrentEditWithRetry,
  resolveConcurrentEdit,
  type DocumentStore,
  type EditPatch,
  type VersionedDocument
} from "../resolver";

interface SampleDocument {
  title: string;
  description: string;
  status: "draft" | "review" | "published";
  tags: string[];
}

function createDoc(version: number, data: SampleDocument): VersionedDocument<SampleDocument> {
  return {
    id: "doc-1",
    version,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "author-init",
    data
  };
}

describe("conflict resolution for concurrent edits (#433)", () => {
  const baseDoc = createDoc(1, {
    title: "Initial Title",
    description: "Initial description",
    status: "draft",
    tags: ["v1"]
  });

  describe("normal path", () => {
    it("applies sequential non-conflicting edit cleanly", () => {
      const patch: EditPatch<SampleDocument> = {
        baseVersion: 1,
        editorId: "editor-a",
        changes: { title: "Updated Title" }
      };

      const res = resolveConcurrentEdit(baseDoc, null, patch);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.version).toBe(2);
        expect(res.value.data.title).toBe("Updated Title");
        expect(res.value.data.description).toBe("Initial description");
      }
    });

    it("automatically merges concurrent edits modifying disjoint fields (3-way merge)", () => {
      // Doc has advanced to version 2 by Editor A changing 'title'
      const currentDoc: VersionedDocument<SampleDocument> = {
        id: "doc-1",
        version: 2,
        updatedAt: "2026-01-01T00:01:00.000Z",
        updatedBy: "editor-a",
        data: {
          ...baseDoc.data,
          title: "Title Changed By Editor A"
        }
      };

      // Editor B started from baseDoc (v1) and edited 'description' concurrently
      const patchB: EditPatch<SampleDocument> = {
        baseVersion: 1,
        editorId: "editor-b",
        changes: { description: "Description Changed By Editor B" }
      };

      const res = resolveConcurrentEdit(currentDoc, baseDoc, patchB, "three-way-merge");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.version).toBe(3);
        // Retains Editor A's title AND incorporates Editor B's description
        expect(res.value.data.title).toBe("Title Changed By Editor A");
        expect(res.value.data.description).toBe("Description Changed By Editor B");
        expect(res.value.updatedBy).toBe("editor-b");
      }
    });
  });

  describe("failure & conflict detection path", () => {
    it("detects conflict and rejects when concurrent edits modify the same field", () => {
      const currentDoc: VersionedDocument<SampleDocument> = {
        id: "doc-1",
        version: 2,
        updatedAt: "2026-01-01T00:01:00.000Z",
        updatedBy: "editor-a",
        data: {
          ...baseDoc.data,
          title: "Editor A Title"
        }
      };

      // Editor B also edited title from v1
      const patchB: EditPatch<SampleDocument> = {
        baseVersion: 1,
        editorId: "editor-b",
        changes: { title: "Editor B Conflicting Title" }
      };

      const res = resolveConcurrentEdit(currentDoc, baseDoc, patchB, "three-way-merge");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("edit_conflict_detected");
        expect(res.detail?.hasConflict).toBe(true);
        expect(res.detail?.conflictingFields).toContain("title");
        expect(res.detail?.currentValues.title).toBe("Editor A Title");
        expect(res.detail?.attemptedValues.title).toBe("Editor B Conflicting Title");
      }
    });

    it("respects last-write-wins strategy when explicitly selected", () => {
      const currentDoc: VersionedDocument<SampleDocument> = {
        id: "doc-1",
        version: 2,
        updatedAt: "2026-01-01T00:01:00.000Z",
        updatedBy: "editor-a",
        data: {
          ...baseDoc.data,
          title: "Editor A Title"
        }
      };

      const patchB: EditPatch<SampleDocument> = {
        baseVersion: 1,
        editorId: "editor-b",
        changes: { title: "Editor B Forced Title" }
      };

      const res = resolveConcurrentEdit(currentDoc, baseDoc, patchB, "last-write-wins");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.data.title).toBe("Editor B Forced Title");
      }
    });
  });

  describe("retry & rebase path", () => {
    it("successfully applies concurrent edit with automated retry and rebase", async () => {
      let doc = { ...baseDoc };
      const store: DocumentStore<SampleDocument> = {
        get: () => ({ ...doc, data: { ...doc.data } }),
        save: (updated) => {
          doc = updated;
        }
      };

      const res = await applyConcurrentEditWithRetry(
        store,
        "doc-1",
        "editor-retry",
        (latest) => ({
          description: `Rebased against v${latest.version}`
        }),
        { maxRetries: 3 }
      );

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.data.description).toBe("Rebased against v1");
        expect(res.value.version).toBe(2);
      }
    });
  });
});
