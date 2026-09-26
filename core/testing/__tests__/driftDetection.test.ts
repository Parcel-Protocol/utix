import { detectDrift, formatDriftReport, assertNoDrift } from "@/core/testing/driftDetection";
import { describe, it, expect } from "vitest";

describe("driftDetection", () => {
  describe("detectDrift", () => {
    it("detects removed fields", () => {
      const fixture = { a: 1, b: 2, c: 3 };
      const live = { a: 1, b: 2 };

      const drifts = detectDrift(fixture, live);
      const removed = drifts.filter((d) => d.type === "removed_field");

      expect(removed.length).toBe(1);
      expect(removed[0].field).toBe("c");
    });

    it("detects added fields", () => {
      const fixture = { a: 1, b: 2 };
      const live = { a: 1, b: 2, c: 3 };

      const drifts = detectDrift(fixture, live);
      const added = drifts.filter((d) => d.type === "added_field");

      expect(added.length).toBe(1);
      expect(added[0].field).toBe("c");
    });

    it("detects type changes", () => {
      const fixture = { a: "string", b: 2 };
      const live = { a: 123, b: 2 };

      const drifts = detectDrift(fixture, live);
      const changed = drifts.filter((d) => d.type === "type_changed");

      expect(changed.length).toBe(1);
      expect(changed[0].field).toBe("a");
      expect(changed[0].fixture).toBe("string");
      expect(changed[0].live).toBe("number");
    });

    it("ignores volatile fields", () => {
      const fixture = {
        data: "value",
        timestamp: "2024-01-01T00:00:00Z"
      };
      const live = {
        data: "value",
        timestamp: "2024-01-02T00:00:00Z"
      };

      const drifts = detectDrift(fixture, live);

      expect(drifts).toHaveLength(0);
    });

    it("ignores cursor field", () => {
      const fixture = { records: [], cursor: "abc123" };
      const live = { records: [], cursor: "xyz789" };

      const drifts = detectDrift(fixture, live);

      expect(drifts).toHaveLength(0);
    });

    it("detects changes in nested objects", () => {
      const fixture = { data: { a: 1, b: 2 } };
      const live = { data: { a: 1 } };

      const drifts = detectDrift(fixture, live);
      const removed = drifts.filter((d) => d.type === "removed_field");

      expect(removed.some((d) => d.field.includes("b"))).toBe(true);
    });

    it("returns empty array for identical structures", () => {
      const fixture = { a: 1, b: "two", c: [1, 2, 3] };
      const live = { a: 1, b: "two", c: [1, 2, 3] };

      const drifts = detectDrift(fixture, live);

      expect(drifts).toHaveLength(0);
    });

    it("handles null values correctly", () => {
      const fixture = { a: null, b: 2 };
      const live = { a: null, b: 2 };

      const drifts = detectDrift(fixture, live);

      expect(drifts).toHaveLength(0);
    });

    it("detects changes from value to null", () => {
      const fixture = { a: 1, b: 2 };
      const live = { a: null, b: 2 };

      const drifts = detectDrift(fixture, live);
      const changed = drifts.filter((d) => d.type === "type_changed");

      expect(changed.length).toBeGreaterThan(0);
    });
  });

  describe("formatDriftReport", () => {
    it("creates a report with summary", () => {
      const fixture = { a: 1 };
      const drifts = [
        { type: "added_field" as const, path: "root", field: "b", live: 2 },
        { type: "removed_field" as const, path: "root", field: "c", fixture: 3 }
      ];

      const report = formatDriftReport("fixture-name", drifts);

      expect(report.fixture).toBe("fixture-name");
      expect(report.drifts).toEqual(drifts);
      expect(report.summary).toContain("1 removed field");
      expect(report.summary).toContain("1 added field");
    });

    it("generates timestamp", () => {
      const report = formatDriftReport("test", []);

      expect(report.timestamp).toBeTruthy();
      expect(new Date(report.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("says no drift when issues array is empty", () => {
      const report = formatDriftReport("test", []);

      expect(report.summary).toBe("No drift detected");
    });
  });

  describe("assertNoDrift", () => {
    it("passes when there is no drift", () => {
      const fixture = { a: 1, b: 2 };
      const live = { a: 1, b: 2 };

      expect(() => assertNoDrift(fixture, live)).not.toThrow();
    });

    it("throws with error message when drift is found", () => {
      const fixture = { a: 1, b: 2 };
      const live = { a: 1, b: 2, c: 3 };

      expect(() => assertNoDrift(fixture, live)).toThrow(/Response shape drift detected/);
    });

    it("includes field path in error message", () => {
      const fixture = { a: 1 };
      const live = { a: 1, b: 2 };

      expect(() => assertNoDrift(fixture, live)).toThrow(/added_field/);
      expect(() => assertNoDrift(fixture, live)).toThrow(/b/);
    });
  });
});
