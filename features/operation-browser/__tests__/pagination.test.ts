import { describe, expect, it } from "vitest";
import {
  appendOperationPage,
  dedupeOperations,
  sortOperations
} from "@/features/operation-browser/lib/operationBrowser";
import { flattenLoadedOperations } from "@/features/operation-browser/lib/format";
import {
  operationBrowserFixture,
  pageOneOperations,
  pageTwoOperations
} from "@/features/operation-browser/fixtures/operationBrowser.fixture";

describe("operation pagination ordering", () => {
  it("deduplicates records across cursor pages", () => {
    const operations = dedupeOperations([...pageOneOperations, ...pageOneOperations.slice(-2), ...pageTwoOperations]);
    expect(operations).toHaveLength(pageOneOperations.length + pageTwoOperations.length);
  });

  it("sorts by timestamp while preserving Horizon order for ties", () => {
    const older = { ...pageOneOperations[0], id: "older", pagingToken: "older", createdAt: "2023-01-01T00:00:00Z" };
    const ordered = sortOperations([older, ...pageOneOperations.slice(0, 2)]);
    expect(ordered.map((operation) => operation.id)).toEqual(["100001", "100002", "older"]);
  });

  it("appends only unseen records and keeps the loaded view stable", () => {
    const duplicateBoundary = [...pageOneOperations.slice(-1), ...pageTwoOperations];
    const appended = appendOperationPage(operationBrowserFixture, duplicateBoundary, false);
    const loaded = flattenLoadedOperations(appended.pages);

    expect(
      new Set(loaded.map((operation) => [operation.id, operation.transactionHash].join("|"))).size
    ).toBe(loaded.length);
    expect(loaded).toHaveLength(pageOneOperations.length + pageTwoOperations.length);
    expect(appended.pages).toHaveLength(2);
    expect(appended.pages[1]).toEqual(pageTwoOperations);
    expect(loaded[0].pagingToken).toBe(pageOneOperations[0].pagingToken);
    expect(appended.hasMoreOlder).toBe(false);
  });
});
