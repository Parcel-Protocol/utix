import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, paginateByCursor } from "@/core/pagination/cursor";

type Row = { id: string; value: number };

const rows: Row[] = Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: index }));

describe("cursor pagination", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCursor("row-3", 2);
    expect(decodeCursor(cursor)).toEqual({ key: "row-3", offset: 2 });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  it("continues after the anchor when rows are inserted before it", () => {
    const first = paginateByCursor(rows, { pageSize: 2, getKey: (row) => row.id });
    const changed = [{ id: "new", value: -1 }, ...rows];
    const second = paginateByCursor(changed, {
      pageSize: 2,
      getKey: (row) => row.id,
      cursor: first.nextCursor ?? undefined
    });

    expect(first.items.map((row) => row.id)).toEqual(["0", "1"]);
    expect(second.items.map((row) => row.id)).toEqual(["2", "3"]);
    expect(second.items.map((row) => row.id)).not.toContain("1");
  });

  it("falls back to the cursor offset after its anchor is deleted", () => {
    const first = paginateByCursor(rows, { pageSize: 2, getKey: (row) => row.id });
    const changed = rows.filter((row) => row.id !== "1");
    const second = paginateByCursor(changed, {
      pageSize: 2,
      getKey: (row) => row.id,
      cursor: first.nextCursor ?? undefined
    });

    expect(second.items.map((row) => row.id)).toEqual(["2", "3"]);
  });

  it("returns no cursor after the final item", () => {
    const page = paginateByCursor(rows, { pageSize: 6, getKey: (row) => row.id });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
