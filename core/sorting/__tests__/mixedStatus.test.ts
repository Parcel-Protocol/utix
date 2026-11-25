import { describe, expect, it } from "vitest";
import {
  pageMixedStatusEvents,
  pageMixedStatusRecords,
  sortMixedStatusEvents,
  sortMixedStatusRecords,
  sortStatusList,
  sortEventList,
  verifyDeterministicOrdering
} from "@/core/sorting";

describe("mixed-status deterministic sorting", () => {
  it("exposes deterministic status and event list helpers", () => {
    const records = [{ id: "b", status: "pending" }, { id: "a", status: "pending" }];
    const events = [{ id: "b", status: "completed", at: 1 }, { id: "a", status: "completed", at: 1 }];
    expect(sortStatusList(records).map((item) => item.id)).toEqual(["a", "b"]);
    expect(sortEventList(events).map((item) => item.id)).toEqual(["a", "b"]);
  });
  it("orders records by actionable status and deterministic tie-breakers", () => {
    const input = [
      { id: "done", status: "completed", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "failure-b", status: "failed", updatedAt: "2026-01-02T00:00:00Z", sequence: 1 },
      { id: "pending", status: "pending", updatedAt: "2026-01-04T00:00:00Z" },
      { id: "failure-a", status: "failed", updatedAt: "2026-01-02T00:00:00Z", sequence: 2 }
    ];
    expect(sortMixedStatusRecords(input).map(({ id }) => id)).toEqual([
      "failure-a", "failure-b", "pending", "done"
    ]);
    expect(input.map(({ id }) => id)).toEqual(["done", "failure-b", "pending", "failure-a"]);
  });

  it("keeps events reverse chronological across statuses", () => {
    const events = [
      { id: "a", status: "completed", at: 10, sequence: 1 },
      { id: "c", status: "running", at: 20, sequence: 1 },
      { id: "b", status: "failed", at: 10, sequence: 1 }
    ];
    expect(sortMixedStatusEvents(events).map(({ id }) => id)).toEqual(["c", "b", "a"]);
  });

  it("sorts unknown statuses and invalid dates without relying on input order", () => {
    const records = [
      { id: "z", status: "future", updatedAt: "bad" },
      { id: "a", status: "future", updatedAt: null },
      { id: "m", status: "experimental", updatedAt: undefined }
    ];
    expect(sortMixedStatusRecords(records).map(({ id }) => id)).toEqual(["m", "a", "z"]);
    expect(sortMixedStatusRecords([...records].reverse()).map(({ id }) => id)).toEqual(["m", "a", "z"]);
  });

  it("only returns the caller-authorized input subset", () => {
    const all = [
      { id: "visible", status: "pending", updatedAt: 1, owner: "ada" },
      { id: "secret", status: "failed", updatedAt: 2, owner: "eve" }
    ];
    const authorized = all.filter((record) => record.owner === "ada");
    expect(sortMixedStatusRecords(authorized).map(({ id }) => id)).toEqual(["visible"]);
  });

  describe("keyset pagination and authorization options (#403)", () => {
    const dataset = [
      { id: "rec-1", status: "failed", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "rec-2", status: "failed", updatedAt: "2026-01-02T00:00:00Z" },
      { id: "rec-3", status: "running", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "rec-4", status: "completed", updatedAt: "2026-01-04T00:00:00Z" },
      { id: "rec-5", status: "completed", updatedAt: "2026-01-05T00:00:00Z" }
    ];

    it("filters records with isVisible authorization predicate", () => {
      const result = sortMixedStatusRecords(dataset, {
        isVisible: (r) => r.status !== "completed"
      });
      expect(result.map((r) => r.id)).toEqual(["rec-2", "rec-1", "rec-3"]);
    });

    it("paginates records deterministically with cursor navigation", () => {
      const page1 = pageMixedStatusRecords(dataset, { limit: 2 });
      expect(page1.items.map((r) => r.id)).toEqual(["rec-2", "rec-1"]);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe("rec-1");

      const page2 = pageMixedStatusRecords(dataset, { cursor: page1.nextCursor, limit: 2 });
      expect(page2.items.map((r) => r.id)).toEqual(["rec-3", "rec-5"]);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBe("rec-5");

      const page3 = pageMixedStatusRecords(dataset, { cursor: page2.nextCursor, limit: 2 });
      expect(page3.items.map((r) => r.id)).toEqual(["rec-4"]);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeUndefined();
    });

    it("paginates events deterministically with newest-first ordering", () => {
      const eventList = [
        { id: "ev-1", status: "failed", at: 100 },
        { id: "ev-2", status: "running", at: 300 },
        { id: "ev-3", status: "completed", at: 200 }
      ];

      const page1 = pageMixedStatusEvents(eventList, { limit: 2 });
      expect(page1.items.map((e) => e.id)).toEqual(["ev-2", "ev-3"]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe("ev-3");

      const page2 = pageMixedStatusEvents(eventList, { cursor: page1.nextCursor, limit: 2 });
      expect(page2.items.map((e) => e.id)).toEqual(["ev-1"]);
      expect(page2.hasMore).toBe(false);
    });

    it("verifies deterministic total ordering without inversions", () => {
      const sorted = sortMixedStatusRecords(dataset);
      const verification = verifyDeterministicOrdering(sorted, "record");

      expect(verification.isDeterministic).toBe(true);
      expect(verification.inversions).toBe(0);
      expect(verification.violations).toEqual([]);

      // Intentionally inverted list
      const inverted = [...sorted].reverse();
      const failedVerification = verifyDeterministicOrdering(inverted, "record");

      expect(failedVerification.isDeterministic).toBe(false);
      expect(failedVerification.inversions).toBeGreaterThan(0);
      expect(failedVerification.violations.length).toBeGreaterThan(0);
    });

    it("maintains retry and permutation invariance across random orderings", () => {
      const original = sortMixedStatusRecords(dataset);
      const shuffled1 = [dataset[4], dataset[0], dataset[3], dataset[1], dataset[2]];
      const shuffled2 = [dataset[2], dataset[1], dataset[4], dataset[0], dataset[3]];

      expect(sortMixedStatusRecords(shuffled1)).toEqual(original);
      expect(sortMixedStatusRecords(shuffled2)).toEqual(original);
    });
  });
});
