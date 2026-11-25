/**
 * Rare-failure fixture generator (#448).
 *
 * Turns a seed into deterministic fault schedules for the
 * `FailureInjectionEngine` — the kind of failures that are too rare to hit by
 * chance: a fault on exactly the Nth attempt, a burst of consecutive faults,
 * and compound faults across two steps. Same seed => identical fixtures, so a
 * failing seed reproduces exactly. No rule uses `probability`, which would
 * re-introduce `Math.random()` at evaluation time.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { err, ok, type Result } from "@/core/result/result";
import type {
  FailureInjectionEngine,
  FailureInjectionRule,
  FaultType
} from "@/core/testing/failure-injection";

export const RARE_FAULT_TYPES: readonly FaultType[] = [
  "http_error",
  "network_timeout",
  "storage_fault",
  "step_interruption",
  "payload_corruption",
  "concurrency_conflict"
];

export type RareFailureKind = "nth_attempt" | "burst" | "compound";

export interface RareFailureFixture {
  readonly id: string;
  readonly seed: number;
  readonly kind: RareFailureKind;
  readonly rules: readonly FailureInjectionRule[];
}

export interface RareFailureOptions {
  readonly workflow: string;
  /** Steps faults may target; compound fixtures need at least two. */
  readonly steps: readonly string[];
  /** Highest attempt number an `nth_attempt` fault may land on (default 5). */
  readonly maxAttempt?: number;
  /** Longest consecutive burst (default 3). */
  readonly maxBurst?: number;
}

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateRareFailureFixture(seed: number, options: RareFailureOptions): RareFailureFixture {
  if (options.steps.length === 0) throw new RangeError("at least one step is required");
  const rand = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  const kinds: RareFailureKind[] = options.steps.length > 1 ? ["nth_attempt", "burst", "compound"] : ["nth_attempt", "burst"];
  const kind = pick(kinds);
  const id = `rare-${kind}-${seed}`;
  const rule = (suffix: string, step: string, condition: FailureInjectionRule["condition"]): FailureInjectionRule => ({
    id: `${id}-${suffix}`,
    workflow: options.workflow,
    targetStep: step,
    faultType: pick(RARE_FAULT_TYPES),
    condition,
    enabled: true
  });

  let rules: FailureInjectionRule[];
  if (kind === "nth_attempt") {
    rules = [rule("a", pick(options.steps), { triggerAttempt: int(2, options.maxAttempt ?? 5) })];
  } else if (kind === "burst") {
    rules = [rule("a", pick(options.steps), { maxTriggers: int(2, options.maxBurst ?? 3) })];
  } else {
    const first = pick(options.steps);
    const second = pick(options.steps.filter((s) => s !== first));
    rules = [rule("a", first, { maxTriggers: 1 }), rule("b", second, { triggerAttempt: int(1, 2) })];
  }
  return { id, seed, kind, rules };
}

/** `count` fixtures from consecutive seeds starting at `baseSeed`. */
export function generateRareFailureCorpus(
  baseSeed: number,
  count: number,
  options: RareFailureOptions
): RareFailureFixture[] {
  return Array.from({ length: count }, (_, i) => generateRareFailureFixture(baseSeed + i, options));
}

/**
 * Installs every rule of a fixture, or none: if any registration is refused
 * (unauthorized caller, invalid rule) the rules already registered are
 * removed again so the engine is left exactly as it was.
 */
export function installRareFailureFixture(
  engine: FailureInjectionEngine,
  fixture: RareFailureFixture,
  auth: AuthContext
): Result<() => void, "permission_denied" | "invalid_rule"> {
  const installed: string[] = [];
  for (const r of fixture.rules) {
    const res = engine.registerRule({ ...r }, auth);
    if (!res.ok) {
      for (const ruleId of installed) engine.unregisterRule(ruleId, auth);
      return err(res.code);
    }
    installed.push(r.id);
  }
  return ok(() => {
    for (const ruleId of installed) engine.unregisterRule(ruleId, auth);
  });
}
