import { describe, expect, it } from "vitest";
import { FailureInjectionEngine } from "@/core/testing/failure-injection";
import {
  RARE_FAULT_TYPES,
  generateRareFailureCorpus,
  generateRareFailureFixture,
  installRareFailureFixture
} from "@/core/testing/rare-failure-fixtures";

const options = { workflow: "ownership", steps: ["propose", "accept", "persist"] };
const maintainer = { role: "maintainer" as const, userId: "maintainer:ADMIN" };
const viewer = { role: "viewer" as const, userId: "viewer:EVE" };

/** Calls `step` until it succeeds or `limit` attempts pass; returns failed attempt count. */
async function failuresBeforeSuccess(engine: FailureInjectionEngine, step: string, limit = 10): Promise<number> {
  let failures = 0;
  for (let i = 0; i < limit; i++) {
    try {
      await engine.wrapAsync(options.workflow, step, async () => "ok");
    } catch {
      failures++;
    }
  }
  return failures;
}

describe("rare-failure fixture generator (#448)", () => {
  describe("normal path", () => {
    it("is deterministic: same seed yields identical fixtures", () => {
      expect(generateRareFailureCorpus(42, 25, options)).toEqual(generateRareFailureCorpus(42, 25, options));
    });

    it("different seeds produce different schedules", () => {
      const ids = new Set(generateRareFailureCorpus(1, 50, options).map((f) => JSON.stringify(f.rules)));
      expect(ids.size).toBeGreaterThan(40);
    });

    it("a corpus covers every fault type and every fixture kind", () => {
      const corpus = generateRareFailureCorpus(7, 200, options);
      const faults = new Set(corpus.flatMap((f) => f.rules.map((r) => r.faultType)));
      expect([...faults].sort()).toEqual([...RARE_FAULT_TYPES].sort());
      expect(new Set(corpus.map((f) => f.kind))).toEqual(new Set(["nth_attempt", "burst", "compound"]));
    });

    it("never uses probabilistic triggers and respects attempt/burst bounds", () => {
      for (const f of generateRareFailureCorpus(100, 200, { ...options, maxAttempt: 4, maxBurst: 3 })) {
        for (const r of f.rules) {
          expect(r.condition?.probability).toBeUndefined();
          if (r.condition?.triggerAttempt !== undefined) expect(r.condition.triggerAttempt).toBeLessThanOrEqual(4);
          if (r.condition?.maxTriggers !== undefined) expect(r.condition.maxTriggers).toBeLessThanOrEqual(3);
        }
        if (f.kind === "compound") expect(f.rules[0].targetStep).not.toBe(f.rules[1].targetStep);
      }
    });

    it("single-step workflows never get compound fixtures", () => {
      const corpus = generateRareFailureCorpus(0, 100, { workflow: "w", steps: ["only"] });
      expect(corpus.every((f) => f.kind !== "compound")).toBe(true);
    });
  });

  describe("failure and retry paths", () => {
    it("an nth_attempt fixture fails exactly that attempt, then recovers on retry", async () => {
      const fixture = generateRareFailureCorpus(0, 100, options).find((f) => f.kind === "nth_attempt")!;
      const engine = new FailureInjectionEngine();
      expect(installRareFailureFixture(engine, fixture, maintainer).ok).toBe(true);

      expect(await failuresBeforeSuccess(engine, fixture.rules[0].targetStep)).toBe(1);
      expect(engine.getHistory()[0].attemptNumber).toBe(fixture.rules[0].condition!.triggerAttempt);
    });

    it("a burst fixture fails exactly maxTriggers consecutive calls, then recovers", async () => {
      const fixture = generateRareFailureCorpus(0, 100, options).find((f) => f.kind === "burst")!;
      const engine = new FailureInjectionEngine();
      installRareFailureFixture(engine, fixture, maintainer);

      expect(await failuresBeforeSuccess(engine, fixture.rules[0].targetStep)).toBe(
        fixture.rules[0].condition!.maxTriggers
      );
    });

    it("rejects workflows with no steps", () => {
      expect(() => generateRareFailureFixture(1, { workflow: "w", steps: [] })).toThrow(RangeError);
    });
  });

  describe("authorization and rollback", () => {
    it("refuses unauthorized installs and leaves the engine untouched", async () => {
      const fixture = generateRareFailureCorpus(0, 100, options).find((f) => f.kind === "compound")!;
      const engine = new FailureInjectionEngine();
      const res = installRareFailureFixture(engine, fixture, viewer);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("permission_denied");
      for (const r of fixture.rules) expect(await failuresBeforeSuccess(engine, r.targetStep)).toBe(0);
    });

    it("rolls back partially-installed rules when a later rule is invalid", async () => {
      const fixture = generateRareFailureCorpus(0, 100, options).find((f) => f.kind === "compound")!;
      const broken = { ...fixture, rules: [fixture.rules[0], { ...fixture.rules[1], targetStep: "" }] };
      const engine = new FailureInjectionEngine();
      const res = installRareFailureFixture(engine, broken, maintainer);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("invalid_rule");
      expect(await failuresBeforeSuccess(engine, fixture.rules[0].targetStep)).toBe(0);
    });

    it("the returned uninstall restores pass-through behaviour", async () => {
      const fixture = generateRareFailureCorpus(0, 100, options).find((f) => f.kind === "burst")!;
      const engine = new FailureInjectionEngine();
      const res = installRareFailureFixture(engine, fixture, maintainer);
      if (!res.ok) throw new Error("install failed");
      res.value();
      expect(await failuresBeforeSuccess(engine, fixture.rules[0].targetStep)).toBe(0);
    });
  });
});
