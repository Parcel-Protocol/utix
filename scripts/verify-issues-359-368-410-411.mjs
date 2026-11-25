#!/usr/bin/env node
/**
 * Automated verification for issues #359, #368, #410 and #411.
 *
 * - #359: property tests for boundary numeric and timestamp values
 * - #368: synthetic monitoring for high-value user journeys
 * - #410: synthetic monitoring for critical workflows
 * - #411: bounded cache invalidation and stale detection
 *
 * Each section exercises the normal, failure, retry and authorization paths
 * against a scripted Horizon, so it needs no network access.
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-359-368-410-411.mjs
 */

import assert from "node:assert/strict";

const { NETWORK_PASSPHRASES } = await import("../core/network/config.ts");
const { setTelemetrySink, createCaptureSink } = await import("../core/telemetry/telemetry.ts");
setTelemetrySink(createCaptureSink());

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #359, #368, #410, #411    ");
console.log("============================================================\n");

const SERVICE = { role: "service" };
const VIEWER = { role: "viewer" };
const MAINTAINER = { role: "maintainer" };
const ACCOUNT = `G${"B".repeat(55)}`;
const HASH = "c".repeat(64);
const instant = async () => {};

/** Scripted Horizon. `failFirst` paths answer 503 once, then succeed. */
function horizon({ failFirst = [], broken = [] } = {}) {
  const seen = new Map();
  let requests = 0;
  const routes = {
    "/": { network_passphrase: NETWORK_PASSPHRASES.testnet, core_latest_ledger: 10, history_latest_ledger: 10 },
    "/operations": { _embedded: { records: [{ paging_token: "9", source_account: ACCOUNT }] } },
    [`/accounts/${ACCOUNT}/operations`]: { _embedded: { records: [{ paging_token: "5" }] } },
    [`/accounts/${ACCOUNT}`]: { id: ACCOUNT, sequence: "1", balances: [{ balance: "1.0000000", asset_type: "native" }] },
    "/transactions": { _embedded: { records: [{ hash: HASH }] } },
    [`/transactions/${HASH}`]: { hash: HASH, successful: true, ledger: 10 },
    "/fee_stats": {
      last_ledger: "10",
      last_ledger_base_fee: "100",
      ledger_capacity_usage: "0.1",
      fee_charged: Object.fromEntries(["min", "p10", "p20", "p30", "p40", "p50", "p60", "p70", "p80", "p90", "p95", "p99", "max"].map((key) => [key, "100"]))
    }
  };
  const fetchImpl = async (input) => {
    requests += 1;
    const { pathname } = new URL(String(input));
    const count = (seen.get(pathname) ?? 0) + 1;
    seen.set(pathname, count);
    if (broken.includes(pathname)) return new Response("{}", { status: 500 });
    if (failFirst.includes(pathname) && count === 1) return new Response("{}", { status: 503 });
    return routes[pathname] ? new Response(JSON.stringify(routes[pathname])) : new Response("{}", { status: 404 });
  };
  return { fetchImpl, requests: () => requests };
}

const options = (fetchImpl) => ({ network: "testnet", horizonUrl: "https://horizon.example", fetch: fetchImpl, sleep: instant });

// -------------------------------------------------------------
// #359 — boundary numeric and timestamp values
// -------------------------------------------------------------
console.log("--> Issue #359: boundary numeric and timestamp properties...");
const { formatUnixSeconds } = await import("../core/format/date.ts");
const { parseRetryAfter, retryDelayMs } = await import("../core/health/probe.ts");
const { StaleProjectionDetector } = await import("../core/cache/stale-detector.ts");
const { createBoundedCache } = await import("../core/cache/bounded-cache.ts");
const { forAll, integer, anyNumber } = await import("../core/testing/property.ts");

for (const value of [1.5, Number.NaN, "abc", "1e3"]) {
  assert.equal(formatUnixSeconds(value), String(value), `formatUnixSeconds(${value}) must not throw`);
}
assert.equal(formatUnixSeconds(8_640_000_000_001n), "8640000000001", "past the Date range is shown raw");
assert.match(formatUnixSeconds(8_640_000_000_000n), /UTC/, "the last representable second is a date");
assert.ok(Number.isFinite(parseRetryAfter("9".repeat(400), 0)), "Retry-After overflow is capped");
assert.equal(StaleProjectionDetector.computeRepairRetryBackoffMs(Number.NaN), 1_000, "NaN attempt backs off from the base");
const unreadable = StaleProjectionDetector.inspect([{ key: "k", value: 1, cachedAt: "nope", ttlMs: 1_000, version: 1 }], [], { currentSchemaVersion: 1, now: 0 });
assert.equal(unreadable.clean, false, "an unreadable timestamp is never fresh");
assert.throws(() => createBoundedCache({ maxEntries: 1, ttlMs: 1 }).set("k", 1, { ledgerSequence: Number.NaN }), RangeError);
forAll(integer(1, 10_000), (attempt) => {
  const delay = retryDelayMs(attempt, { baseDelayMs: 500, maxDelayMs: 10_000 });
  assert.ok(delay >= 0 && delay <= 10_000);
}, { label: "retry delay bound", runs: 200 });
forAll(anyNumber, (attempt) => {
  const delay = StaleProjectionDetector.computeRepairRetryBackoffMs(attempt);
  assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= 30_000);
}, { label: "repair backoff bound", runs: 200 });
console.log("    [PASS] #359 boundary properties hold\n");

// -------------------------------------------------------------
// #368 — high-value user journeys
// -------------------------------------------------------------
console.log("--> Issue #368: high-value synthetic journeys...");
const { runJourney, JOURNEY_IDS } = await import("../core/health/journeys.ts");

for (const journey of JOURNEY_IDS) {
  const outcome = await runJourney(SERVICE, journey, options(horizon().fetchImpl));
  assert.ok(outcome.ok, `${journey} runs for the service role`);
  assert.equal(outcome.value.status, "healthy", `${journey} is healthy against a healthy Horizon`);
}
const retried = await runJourney(SERVICE, "fee-stats", options(horizon({ failFirst: ["/fee_stats"] }).fetchImpl));
assert.equal(retried.value.status, "degraded", "a recovered transient failure is degraded");
const failed = await runJourney(SERVICE, "transaction-lookup", options(horizon({ broken: ["/transactions"] }).fetchImpl));
assert.equal(failed.value.status, "unhealthy");
assert.deepEqual(failed.value.steps.map((step) => step.skipped === true), [false, false, true], "later steps are listed as skipped");
const denied = horizon();
assert.deepEqual(await runJourney(VIEWER, "account-balances", options(denied.fetchImpl)), { ok: false, code: "synthetic_unauthorized" });
assert.equal(denied.requests(), 0, "a refused journey makes no request");
console.log("    [PASS] #368 journeys cover normal, retry, failure and authorization paths\n");

// -------------------------------------------------------------
// #410 — critical workflow monitoring
// -------------------------------------------------------------
console.log("--> Issue #410: critical workflow monitor...");
const { createWorkflowMonitor } = await import("../core/health/workflow-monitor.ts");

const monitor = createWorkflowMonitor();
const broken = options(horizon({ broken: ["/transactions"] }).fetchImpl);
const first = await monitor.run(SERVICE, broken);
assert.equal(first.value.status, "degraded", "one failure does not alert");
const second = await monitor.run(SERVICE, broken);
assert.equal(second.value.status, "unhealthy", "a second failure of a critical journey alerts");
assert.deepEqual(second.value.alerts.map((alert) => [alert.journey, alert.transition]), [["transaction-lookup", "opened"]]);

const restored = createWorkflowMonitor();
assert.ok(restored.importState(JSON.parse(JSON.stringify(monitor.state()))).ok, "state round-trips through JSON");
const recovered = await restored.run(SERVICE, options(horizon().fetchImpl));
assert.deepEqual(recovered.value.alerts.map((alert) => alert.transition), ["resolved"], "recovery resolves the carried alert");
assert.equal(restored.importState({ version: 99, journeys: [] }).ok, false, "a future state version is refused");
assert.deepEqual(await monitor.run(VIEWER, broken), { ok: false, code: "synthetic_unauthorized" });
console.log("    [PASS] #410 workflow alerting opens, holds, resolves and persists\n");

// -------------------------------------------------------------
// #411 — bounded cache invalidation and stale detection
// -------------------------------------------------------------
console.log("--> Issue #411: bounded cache invalidation and stale detection...");
let clock = 0;
const cache = createBoundedCache({ maxEntries: 3, ttlMs: 1_000, now: () => clock });
cache.set("balances:GA", "1", { ledgerSequence: 10, sourceEntityId: "GA" });
cache.set("offers:GA", "2", { ledgerSequence: 10, sourceEntityId: "GA" });
cache.set("balances:GB", "3", { ledgerSequence: 12, sourceEntityId: "GB" });
cache.set("fees", "4"); // evicts the least recently used key; the bound holds
assert.equal(cache.stats().size, 3);

assert.deepEqual(cache.get("balances:GB", { minLedgerSequence: 12 }), { ok: true, value: "3" });
assert.deepEqual(cache.get("offers:GA", { minLedgerSequence: 11 }), { ok: false, code: "cache_stale" }, "behind the head is stale");
assert.deepEqual(cache.get("offers:GA"), { ok: false, code: "cache_miss" }, "and evicted for everyone");

cache.set("offers:GB", "5", { sourceEntityId: "GB" });
assert.equal(cache.invalidateEntity("GB"), 2, "entity invalidation drops every projection of the record");

let loads = 0;
const flaky = async () => (++loads === 1 ? { ok: false, code: "load_failed" } : { ok: true, value: "fresh" });
assert.equal((await cache.getOrLoad("balances:GC", flaky)).ok, false);
assert.deepEqual(await cache.getOrLoad("balances:GC", flaky), { ok: true, value: "fresh" }, "a failed load is retried, not cached");

clock += 1_001;
assert.deepEqual(cache.evictStale(VIEWER, "nope"), { ok: false, code: "cache_unauthorized" });
const evicted = cache.evictStale(MAINTAINER, "verify");
assert.ok(evicted.ok);
assert.deepEqual([...evicted.value.evicted].sort(), ["balances:GC", "fees"], "the maintainer sweep evicts exactly the expired entries");
assert.equal(cache.stats().size, 0);

// A stricter reader must not inherit an older caller's in-flight ledger snapshot.
const freshnessCache = createBoundedCache({ maxEntries: 2, ttlMs: 1_000 });
let releaseOld;
const oldRead = freshnessCache.getOrLoad("account", () => new Promise((resolve) => { releaseOld = resolve; }), { ledgerSequence: 10 });
await Promise.resolve();
const strictRead = freshnessCache.getOrLoad("account", async () => ({ ok: true, value: "fresh-12" }), { minLedgerSequence: 12, ledgerSequence: 12 });
releaseOld({ ok: true, value: "old-10" });
assert.deepEqual(await oldRead, { ok: true, value: "old-10" });
assert.deepEqual(await strictRead, { ok: false, code: "cache_stale_write" });
assert.deepEqual(freshnessCache.get("account"), { ok: false, code: "cache_miss" });
assert.deepEqual(await freshnessCache.getOrLoad("account", async () => ({ ok: true, value: "fresh-12" }), { minLedgerSequence: 12, ledgerSequence: 12 }), { ok: true, value: "fresh-12" });
assert.deepEqual(await freshnessCache.getOrLoad("other", async () => ({ ok: true, value: "old-19" }), { minLedgerSequence: 20, ledgerSequence: 19 }), { ok: false, code: "cache_stale_write" });
assert.deepEqual(freshnessCache.get("other"), { ok: false, code: "cache_miss" });
console.log("    [PASS] #411 bounded cache invalidates by key, entity, head and sweep\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#359, #368, #410, #411) VERIFIED [PASS]    ");
console.log("============================================================");
