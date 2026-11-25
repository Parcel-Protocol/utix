import { afterEach, describe, expect, it } from "vitest";
import { hasPermission, type Role } from "@/core/auth/types";
import { createBoundedCache } from "@/core/cache/bounded-cache";
import { StaleProjectionDetector } from "@/core/cache/stale-detector";
import { formatDateTime, formatUnixSeconds } from "@/core/format/date";
import { runJourney } from "@/core/health/journeys";
import { createProbe, parseRetryAfter, retryDelayMs } from "@/core/health/probe";
import { createWorkflowMonitor } from "@/core/health/workflow-monitor";
import { ok } from "@/core/result/result";
import { resetTelemetrySink, setTelemetrySink, createCaptureSink } from "@/core/telemetry/telemetry";
import {
  anyNumber,
  bigInteger,
  constantFrom,
  forAll,
  forAllAsync,
  integer,
  map,
  oneOf,
  tuple,
  type Arbitrary
} from "@/core/testing/property";

/**
 * Property tests for boundary numeric and timestamp values (#359).
 *
 * Every property is checked on the boundary values first (zero, ±1 around a
 * limit, the limit itself, NaN, ±Infinity, -0, unsafe integers) and then on
 * seeded random values. A failure prints its seed:
 *
 *   PROPERTY_SEED=<seed> npm test -- core/__tests__/boundary-properties
 *
 * The defects these properties found are fixed and listed in docs/FUZZING.md.
 */

/** The ECMAScript Date range: ±8.64e15 ms around the epoch. */
const DATE_LIMIT_MS = 8_640_000_000_000_000;
const DATE_LIMIT_S = 8_640_000_000_000n;
const UINT32_MAX = 2 ** 32 - 1;
const START = Date.parse("2026-10-17T00:00:00.000Z");

/** Roles a misconfigured `UTIX_USER_ROLE` can produce, plus prototype keys. */
const ROLES = constantFrom<string>("viewer", "maintainer", "service", "admin", "", "__proto__", "toString", "constructor", "SERVICE");

/** Strings near a timestamp's grammar: digits, signs, fractions, garbage. */
const timestampStrings: Arbitrary<string> = {
  boundaries: ["", " ", "0", "-0", "+1", "1.5", "1e3", "0x10", "abc", " 42 ", "9".repeat(400), String(DATE_LIMIT_S), String(DATE_LIMIT_S + 1n)],
  generate: (random) => random.string("0123456789-+. eE", 24)
};

afterEach(() => resetTelemetrySink());

describe("boundary numeric and timestamp properties (#359)", () => {
  describe("timestamps", () => {
    it("formatUnixSeconds never throws and formats exactly the representable range", () => {
      const seconds = oneOf<bigint | number | string>(
        bigInteger(-(2n ** 64n), 2n ** 64n),
        bigInteger(-DATE_LIMIT_S - 2n, DATE_LIMIT_S + 2n),
        anyNumber,
        timestampStrings
      );
      forAll(seconds, (value) => {
        const formatted = formatUnixSeconds(value);
        expect(typeof formatted).toBe("string");
        expect(formatted).not.toContain("Invalid Date");

        const integral =
          typeof value === "bigint" ||
          (typeof value === "number" && Number.isInteger(value)) ||
          (typeof value === "string" && /^\s*[-+]?\d+\s*$/.test(value));
        if (!integral) {
          expect(formatted).toBe(String(value));
          return;
        }
        const asBigInt = BigInt(typeof value === "string" ? value.trim() : value);
        const representable = asBigInt <= DATE_LIMIT_S && asBigInt >= -DATE_LIMIT_S;
        // In range it is a date (it names UTC); out of range it is shown as given.
        if (representable) expect(formatted).toMatch(/UTC/);
        else expect(formatted).toBe(String(value));
      }, { label: "formatUnixSeconds" });
    });

    it("formatDateTime never throws and never renders Invalid Date", () => {
      const values = oneOf<number | string>(
        anyNumber,
        constantFrom(DATE_LIMIT_MS, DATE_LIMIT_MS + 1, -DATE_LIMIT_MS, -DATE_LIMIT_MS - 1),
        constantFrom("2026-02-29T00:00:00Z", "2024-02-29T00:00:00Z", "not a date", "", "1970-01-01T00:00:00.000Z")
      );
      forAll(values, (value) => {
        const formatted = formatDateTime(value);
        expect(formatted).not.toContain("Invalid Date");
        if (Number.isNaN(new Date(value).getTime())) expect(formatted).toBe(String(value));
      }, { label: "formatDateTime" });
    });

    it("parseRetryAfter always yields a finite, non-negative delay or undefined", () => {
      const header = oneOf<string>(
        timestampStrings,
        map(integer(-1_000_000_000, 1_000_000_000), (offset) => new Date(START + offset * 1_000).toUTCString()),
        constantFrom("Mon", "Sun, 99 Foo 2026 00:00:00 GMT", "-1", "1.5", "  7  ")
      );
      forAll(header, (value) => {
        const delay = parseRetryAfter(value, START);
        if (delay === undefined) return;
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }, { label: "parseRetryAfter" });
    });

    it("parseRetryAfter reads delay-seconds and HTTP-dates exactly, clamping the past to zero", () => {
      forAll(integer(0, 1_000_000_000), (seconds) => {
        expect(parseRetryAfter(String(seconds), START)).toBe(seconds * 1_000);
      }, { label: "delay-seconds" });
      forAll(integer(-1_000_000_000, 1_000_000_000), (offset) => {
        const date = new Date(START + offset * 1_000).toUTCString();
        expect(parseRetryAfter(date, START)).toBe(Math.max(0, offset * 1_000));
      }, { label: "HTTP-date" });
    });
  });

  describe("retry backoff", () => {
    const settings = tuple(integer(0, 60_000), integer(0, 120_000));

    it("retryDelayMs stays within [0, maxDelayMs] for any attempt or Retry-After", () => {
      const inputs = tuple(tuple(oneOf(integer(1, 5_000), anyNumber), oneOf(anyNumber, constantFrom<number>(Number.NaN))), settings);
      forAll(inputs, ([[attempt, retryAfter], [baseDelayMs, maxDelayMs]]) => {
        const delay = retryDelayMs(attempt, { baseDelayMs, maxDelayMs }, Number.isFinite(retryAfter) ? Math.abs(retryAfter) : undefined);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(maxDelayMs);
      }, { label: "retryDelayMs bounds" });
    });

    it("retryDelayMs never shrinks as attempts grow", () => {
      forAll(tuple(integer(1, 2_000), settings), ([attempt, [baseDelayMs, maxDelayMs]]) => {
        expect(retryDelayMs(attempt + 1, { baseDelayMs, maxDelayMs })).toBeGreaterThanOrEqual(
          retryDelayMs(attempt, { baseDelayMs, maxDelayMs })
        );
      }, { label: "retryDelayMs monotonic" });
    });

    it("computeRepairRetryBackoffMs is always within [0, maxMs], even for NaN or negative attempts", () => {
      forAll(anyNumber, (attempt) => {
        const delay = StaleProjectionDetector.computeRepairRetryBackoffMs(attempt, 1_000, 30_000);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(30_000);
        if (attempt >= 0 && Number.isFinite(attempt)) expect(delay).toBeGreaterThanOrEqual(1_000);
      }, { label: "computeRepairRetryBackoffMs" });
    });

    it("a step succeeds iff its transient failures are fewer than maxAttempts, and attempts are exact", async () => {
      const cases = tuple(integer(0, 6), integer(1, 5));
      await forAllAsync(cases, async ([failures, maxAttempts]) => {
        let calls = 0;
        const sleeps: number[] = [];
        const probe = createProbe<"step">({
          baseUrl: "https://horizon.example",
          maxAttempts,
          baseDelayMs: 500,
          maxDelayMs: 2_000,
          sleep: async (ms) => void sleeps.push(ms),
          fetch: (async () => (calls++ < failures ? new Response("{}", { status: 503 }) : new Response("{}"))) as typeof fetch
        });
        const value = await probe.step("step", "", {}, () => ok(true));
        expect(value === true).toBe(failures < maxAttempts);
        expect(probe.steps[0].attempts).toBe(Math.min(failures + 1, maxAttempts));
        expect(sleeps).toHaveLength(probe.steps[0].attempts - 1);
        expect(sleeps.every((ms) => ms >= 0 && ms <= 2_000)).toBe(true);
      }, { label: "probe retry", runs: 50 });
    });
  });

  describe("cache TTL and ledger boundaries", () => {
    it("an entry is served iff its age is at most its TTL", () => {
      forAll(tuple(integer(1, 2 ** 40), integer(0, 2 ** 41)), ([ttlMs, ageMs]) => {
        let clock = START;
        const cache = createBoundedCache<string>({ maxEntries: 1, ttlMs, now: () => clock });
        cache.set("k", "v");
        clock += ageMs;
        expect(cache.get("k").ok).toBe(ageMs <= ttlMs);
      }, { label: "TTL boundary" });
    });

    it("a write never moves a key's ledger sequence backwards", () => {
      const ledgers = tuple(integer(0, UINT32_MAX), integer(0, UINT32_MAX));
      forAll(ledgers, ([first, second]) => {
        const cache = createBoundedCache<number>({ maxEntries: 1, ttlMs: 1_000, now: () => START });
        cache.set("k", first, { ledgerSequence: first });
        const written = cache.set("k", second, { ledgerSequence: second });
        expect(written.ok).toBe(second >= first);
        expect(cache.get("k")).toEqual(ok(Math.max(first, second)));
      }, { label: "stale write" });
    });

    it("a ledger sequence is either rejected up front or keeps the stale-write guard working", () => {
      forAll(anyNumber, (sequence) => {
        const cache = createBoundedCache<string>({ maxEntries: 1, ttlMs: 1_000, now: () => START });
        let accepted = true;
        try {
          cache.set("k", "first", { ledgerSequence: sequence });
        } catch (error) {
          accepted = false;
          expect(error).toBeInstanceOf(RangeError);
        }
        expect(accepted).toBe(Number.isSafeInteger(sequence) && sequence >= 0);
        // An older write after an accepted one is always refused (NaN used to disable this).
        if (accepted && sequence > 0) expect(cache.set("k", "older", { ledgerSequence: sequence - 1 })).toMatchObject({ ok: false });
      }, { label: "ledgerSequence validation" });
    });

    it("a read with a known ledger head is served iff the entry is at or after it", () => {
      forAll(tuple(integer(0, UINT32_MAX), integer(0, UINT32_MAX)), ([entryLedger, head]) => {
        const cache = createBoundedCache<string>({ maxEntries: 1, ttlMs: 1_000, now: () => START });
        cache.set("k", "v", { ledgerSequence: entryLedger });
        const read = cache.get("k", { minLedgerSequence: head });
        expect(read.ok).toBe(entryLedger >= head);
        if (!read.ok) expect(read.code).toBe("cache_stale");
      }, { label: "minLedgerSequence" });
    });

    it("the detector reports an age that is always finite and never calls an unreadable timestamp fresh", () => {
      const cachedAt = oneOf<number | string>(
        anyNumber,
        integer(START - 10_000, START + 10_000),
        constantFrom("not-a-date", "", "2026-13-01T00:00:00Z", new Date(START).toISOString())
      );
      forAll(cachedAt, (value) => {
        const report = StaleProjectionDetector.inspect(
          [{ key: "k", value: 1, cachedAt: value, ttlMs: 1_000, version: 1 }],
          [],
          { currentSchemaVersion: 1, now: START }
        );
        for (const finding of report.findings) {
          expect(Number.isFinite(finding.ageMs)).toBe(true);
          expect(finding.ageMs).toBeGreaterThanOrEqual(0);
        }
        const ms = typeof value === "string" ? Date.parse(value) : value;
        if (!Number.isFinite(ms)) expect(report.clean).toBe(false);
        else expect(report.clean).toBe(START - ms <= 1_000);
      }, { label: "detector timestamps" });
    });

    it("ledger drift is tolerated up to the limit and flagged one ledger past it", () => {
      forAll(tuple(integer(0, 1_000), integer(0, UINT32_MAX - 2_000)), ([maxDrift, head]) => {
        const report = (drift: number) =>
          StaleProjectionDetector.inspect(
            [{ key: "k", value: 1, cachedAt: START, ttlMs: 1_000, version: 1, ledgerSequence: head + 1_000 - drift }],
            [],
            { currentSchemaVersion: 1, now: START, authoritativeLedgerSequence: head + 1_000, maxToleratedDriftLedgers: maxDrift }
          );
        expect(report(maxDrift).clean).toBe(true);
        expect(report(maxDrift + 1).findings[0]?.staleReason).toBe("ledger_drift");
      }, { label: "ledger drift" });
    });
  });

  describe("authorization boundaries", () => {
    it("cache flush and stale eviction succeed for exactly the roles holding admin:recovery", () => {
      setTelemetrySink(createCaptureSink());
      forAll(ROLES, (role) => {
        const cache = createBoundedCache<string>({ maxEntries: 2, ttlMs: 1_000, now: () => START });
        cache.set("k", "v");
        const allowed = hasPermission(role as Role, "admin:recovery");
        expect(cache.evictStale({ role: role as Role }, "property").ok).toBe(allowed);
        expect(cache.clear({ role: role as Role }, "property").ok).toBe(allowed);
        // A refused flush leaves the cache untouched.
        if (!allowed) expect(cache.stats().size).toBe(1);
      }, { label: "cache authorization" });
    });

    it("journeys and workflows run for exactly the roles holding admin:health, and a refusal makes no request", async () => {
      setTelemetrySink(createCaptureSink());
      await forAllAsync(ROLES, async (role) => {
        let requests = 0;
        const fetchImpl = (async () => {
          requests += 1;
          return new Response("{}", { status: 404 });
        }) as typeof fetch;
        const options = { network: "testnet", horizonUrl: "https://horizon.example", fetch: fetchImpl, sleep: async () => {} } as const;
        const allowed = hasPermission(role as Role, "admin:health");

        const journey = await runJourney({ role: role as Role }, "fee-stats", options);
        const workflow = await createWorkflowMonitor({ journeys: ["fee-stats"] }).run({ role: role as Role }, options);
        expect(journey.ok).toBe(allowed);
        expect(workflow.ok).toBe(allowed);
        if (!allowed) {
          expect(journey).toEqual({ ok: false, code: "synthetic_unauthorized" });
          expect(requests).toBe(0);
        }
      }, { label: "synthetic authorization", runs: 20 });
    });
  });
});
