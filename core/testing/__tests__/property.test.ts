import { describe, expect, it } from "vitest";
import { bigInteger, constantFrom, forAll, forAllAsync, integer, prng, tuple } from "../property";

describe("property harness (#359)", () => {
  it("checks every boundary before any random value", () => {
    const seen: number[] = [];
    forAll(integer(-5, 5), (value) => void seen.push(value), { runs: 3, seed: 1 });
    expect(seen.slice(0, 6)).toEqual([-5, -4, -1, 0, 1, 4]);
    expect(seen.slice(6, 7)).toEqual([5]);
    expect(seen).toHaveLength(7 + 3);
  });

  it("draws the same values for the same seed", () => {
    const draw = (seed: number) => {
      const values: bigint[] = [];
      forAll(bigInteger(0n, 2n ** 64n), (value) => void values.push(value), { runs: 20, seed });
      return values;
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it("keeps generated values inside the declared range", () => {
    forAll(tuple(integer(-3, 3), bigInteger(-(2n ** 70n), 2n ** 70n)), ([small, big]) => {
      expect(small).toBeGreaterThanOrEqual(-3);
      expect(small).toBeLessThanOrEqual(3);
      expect(big >= -(2n ** 70n) && big <= 2n ** 70n).toBe(true);
    });
  });

  it("names the seed and the counterexample when a property fails", () => {
    expect(() => forAll(integer(0, 100), (value) => value < 100, { seed: 7, label: "below 100" })).toThrow(
      /below 100 failed on boundary #\d+ \(seed 7; rerun with PROPERTY_SEED=7\)\.\nCounterexample: 100/
    );
  });

  it("reports async failures with the same detail", async () => {
    await expect(
      forAllAsync(constantFrom(1n, 2n), async (value) => {
        expect(value).toBe(1n);
      }, { seed: 9 })
    ).rejects.toThrow(/Counterexample: 2n/);
  });

  it("refuses an empty integer range", () => {
    expect(() => integer(2, 1)).toThrow(RangeError);
    expect(() => bigInteger(2n, 1n)).toThrow(RangeError);
  });

  it("spreads draws across the unit interval", () => {
    const random = prng(1234);
    const buckets = Array.from({ length: 10 }, () => 0);
    for (let index = 0; index < 10_000; index += 1) buckets[Math.floor(random.next() * 10)] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(800);
  });
});
