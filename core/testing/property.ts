/**
 * Seeded property testing without a dependency (#359).
 *
 * `forAll(arbitrary, property)` first checks every *boundary* value the
 * arbitrary declares (zero, ±1 around a limit, the limit itself, NaN, …) and
 * then `runs` values drawn from a seeded PRNG. Boundaries are where off-by-one
 * and overflow bugs live, so they are never left to chance; the random draws
 * cover the space between them.
 *
 * A failure throws with the label, the seed, the run index and the
 * counterexample, so it reproduces exactly:
 *
 *   PROPERTY_SEED=<seed> npm test -- <file>
 *
 * Complexity: O(boundaries + runs) property evaluations; O(1) extra space.
 */

/** Default seed. Override per run with `PROPERTY_SEED` (or the older `FUZZ_SEED`). */
export const DEFAULT_PROPERTY_SEED = 0x5eed_0359;
export const DEFAULT_PROPERTY_RUNS = 500;

export function propertySeed(fallback = DEFAULT_PROPERTY_SEED): number {
  const raw = process.env.PROPERTY_SEED ?? process.env.FUZZ_SEED;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** mulberry32: tiny, fast, and good enough to spread inputs. Not crypto. */
export function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const string = (alphabet: string, maxLength: number) =>
    Array.from({ length: int(maxLength + 1) }, () => alphabet[int(alphabet.length)]).join("");
  /** Uniform over the full signed 64-bit range. */
  const int64 = () => {
    const high = BigInt(int(2 ** 32)) << 32n;
    return BigInt.asIntN(64, high | BigInt(int(2 ** 32)));
  };
  return { next, int, pick, string, int64 };
}

export type Random = ReturnType<typeof prng>;

export interface Arbitrary<T> {
  /** Values that are always checked, before any random draw. */
  readonly boundaries: readonly T[];
  generate(random: Random): T;
}

export interface ForAllOptions {
  readonly runs?: number;
  readonly seed?: number;
  /** Names the property in a failure message. */
  readonly label?: string;
}

/** Renders a counterexample, including the values `JSON.stringify` loses. */
export function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return `Date(${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()})`;
  if (Array.isArray(value)) return `[${value.map(describeValue).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${describeValue(item)}`).join(", ")} }`;
  }
  return String(value);
}

/**
 * Checks `property` for every boundary and `runs` random values. The property
 * fails by throwing (e.g. a failed `expect`) or by returning `false`.
 */
export function forAll<T>(
  arbitrary: Arbitrary<T>,
  property: (value: T) => boolean | void,
  options: ForAllOptions = {}
): void {
  const seed = options.seed ?? propertySeed();
  const runs = options.runs ?? DEFAULT_PROPERTY_RUNS;
  const random = prng(seed);
  const label = options.label ?? "property";

  const check = (value: T, where: string) => {
    let failure: unknown;
    try {
      if (property(value) === false) failure = new Error("returned false");
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) throw new Error(failureMessage(label, where, seed, value, failure));
  };

  arbitrary.boundaries.forEach((value, index) => check(value, `boundary #${index}`));
  for (let run = 0; run < runs; run += 1) check(arbitrary.generate(random), `run #${run}`);
}

function failureMessage(label: string, where: string, seed: number, value: unknown, failure: unknown): string {
  const reason = failure instanceof Error ? failure.message : String(failure);
  return (
    `${label} failed on ${where} (seed ${seed}; rerun with PROPERTY_SEED=${seed}).\n` +
    `Counterexample: ${describeValue(value)}\n${reason}`
  );
}

/** `forAll` for async properties. Values are checked one at a time, in order. */
export async function forAllAsync<T>(
  arbitrary: Arbitrary<T>,
  property: (value: T) => Promise<boolean | void>,
  options: ForAllOptions = {}
): Promise<void> {
  const seed = options.seed ?? propertySeed();
  const runs = options.runs ?? DEFAULT_PROPERTY_RUNS;
  const random = prng(seed);
  const label = options.label ?? "property";

  const check = async (value: T, where: string) => {
    let failure: unknown;
    try {
      if ((await property(value)) === false) failure = new Error("returned false");
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) throw new Error(failureMessage(label, where, seed, value, failure));
  };

  for (const [index, value] of arbitrary.boundaries.entries()) await check(value, `boundary #${index}`);
  for (let run = 0; run < runs; run += 1) await check(arbitrary.generate(random), `run #${run}`);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

function unique<T>(values: readonly T[]): T[] {
  const seen: T[] = [];
  for (const value of values) if (!seen.some((other) => Object.is(other, value))) seen.push(value);
  return seen;
}

/** Integers in `[min, max]` (safe-integer range), boundaries at both ends and around zero. */
export function integer(min: number, max: number): Arbitrary<number> {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new RangeError(`integer(${min}, ${max}) needs safe integers with min <= max`);
  }
  const span = max - min;
  return {
    boundaries: unique([min, min + 1, -1, 0, 1, max - 1, max].filter((value) => value >= min && value <= max)),
    generate: (random) => min + Math.floor(random.next() * (span + 1))
  };
}

/** BigInts in `[min, max]`, boundaries at both ends and around zero. */
export function bigInteger(min: bigint, max: bigint): Arbitrary<bigint> {
  if (min > max) throw new RangeError("bigInteger needs min <= max");
  const span = max - min + 1n;
  return {
    boundaries: unique([min, min + 1n, -1n, 0n, 1n, max - 1n, max].filter((value) => value >= min && value <= max)),
    generate: (random) => {
      // 32 random bits per limb, enough limbs to cover the span, then reduce.
      let drawn = 0n;
      for (let bits = 0n; 1n << bits < span; bits += 32n) drawn = (drawn << 32n) | BigInt(random.int(2 ** 32));
      return min + (drawn % span);
    }
  };
}

/** Numbers that break naive arithmetic: NaN, ±Infinity, -0, fractions, unsafe integers. */
export const HOSTILE_NUMBERS: readonly number[] = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER - 1,
  Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32, 2 ** 53, 2 ** 64
];

/** Any number, hostile ones first. */
export const anyNumber: Arbitrary<number> = {
  boundaries: HOSTILE_NUMBERS,
  generate: (random) => {
    const roll = random.next();
    if (roll < 0.3) return random.pick(HOSTILE_NUMBERS);
    if (roll < 0.6) return Math.floor((random.next() - 0.5) * 2 ** random.int(64));
    return (random.next() - 0.5) * 10 ** random.int(20);
  }
};

/** One of the given arbitraries per draw; boundaries are the union of theirs. */
export function oneOf<T>(...arbitraries: readonly Arbitrary<T>[]): Arbitrary<T> {
  return {
    boundaries: arbitraries.flatMap((arbitrary) => arbitrary.boundaries),
    generate: (random) => random.pick(arbitraries).generate(random)
  };
}

/** A fixed set of values, every one of them a boundary. */
export function constantFrom<T>(...values: readonly T[]): Arbitrary<T> {
  return { boundaries: values, generate: (random) => random.pick(values) };
}

export function map<T, U>(arbitrary: Arbitrary<T>, project: (value: T) => U): Arbitrary<U> {
  return {
    boundaries: arbitrary.boundaries.map(project),
    generate: (random) => project(arbitrary.generate(random))
  };
}

/**
 * Pairs of values. Boundaries are every pair of the two boundary lists, which
 * stays small for the 5–10-value lists used here.
 */
export function tuple<A, B>(first: Arbitrary<A>, second: Arbitrary<B>): Arbitrary<readonly [A, B]> {
  return {
    boundaries: first.boundaries.flatMap((a) => second.boundaries.map((b) => [a, b] as const)),
    generate: (random) => [first.generate(random), second.generate(random)] as const
  };
}
