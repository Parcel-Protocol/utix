import { describe, expect, it } from "vitest";
import { hasPermission, type Role } from "@/core/auth/types";
import { encodeCursor, paginateByCursor } from "@/core/pagination/cursor";

type ProtectedRecord = { id: string; readers: readonly Role[]; value: string };
const rows: ProtectedRecord[] = [
  { id: "a", readers: ["viewer", "maintainer"], value: "public" },
  { id: "b", readers: ["maintainer"], value: "restricted-b" },
  { id: "c", readers: ["viewer", "maintainer"], value: "public-again" },
  { id: "d", readers: ["maintainer"], value: "restricted-d" },
  { id: "e", readers: ["viewer", "maintainer"], value: "public-end" }
];
const compare = (a: string, b: string) => a.localeCompare(b);

function pageFor(role: Role, records: ProtectedRecord[], cursor?: string) {
  const authorized = hasPermission(role, "view:dashboard");
  return paginateByCursor(records, {
    pageSize: 1,
    getKey: (record) => record.id,
    compareKeys: compare,
    cursor,
    isVisible: (record) => authorized && record.readers.includes(role)
  });
}

describe("permission and hidden record pagination contract (#362)", () => {
  it("rechecks visibility after permissions are revoked between requests", () => {
    const first = pageFor("viewer", rows);
    expect(first.items.map((record) => record.id)).toEqual(["a"]);

    // The anchor is now hidden and the role lost dashboard access. A stale
    // cursor cannot restore access or disclose the hidden record's value.
    const revokedRows = rows.map((record) => ({
      ...record,
      readers: record.readers.filter((reader) => reader !== "viewer")
    }));
    const revoked = pageFor("viewer", revokedRows, first.nextCursor ?? undefined);
    expect(revoked.items).toEqual([]);
    expect(revoked.nextCursor).toBeNull();
  });

  it("omits hidden rows from pages and resumes by key when the anchor disappears", () => {
    const first = pageFor("maintainer", rows, encodeCursor("b"));
    const restrictedRemoved = rows.filter((record) => record.id !== "b" && record.id !== "d");
    const viewerPage = pageFor("viewer", restrictedRemoved, encodeCursor("b"));
    expect(viewerPage.items.map((record) => record.id)).toEqual(["c"]);
    expect(JSON.stringify(viewerPage)).not.toContain("restricted");
    expect(first.items[0].id).toBe("c");
  });

  it("denies roles without dashboard authorization even when rows are otherwise readable", () => {
    expect(pageFor("service", rows).items).toEqual([]);
    expect(pageFor("service", rows).hasMore).toBe(false);
  });
});
