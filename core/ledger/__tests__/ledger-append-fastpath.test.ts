import { describe, expect, it } from "vitest";
import { createLedger, LEDGER_STORAGE_KEY, type LedgerInput } from "@/core/ledger/ledger";
import type { AuditStorage } from "@/core/audit/audit";
import { runLoad } from "@/core/testing/load-budget";

/** #392: the append fast path must be invisible except in cost. */

const START = Date.parse("2026-10-01T00:00:00.000Z");

function memory(): AuditStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => void raw.set(key, value),
    removeItem: (key) => void raw.delete(key)
  };
}

function setup(limit?: number) {
  const storage = memory();
  let tick = 0;
  const ledger = createLedger({ storage, limit, now: () => START + 1000 * tick++ });
  return { ledger, storage, blob: () => storage.raw.get(LEDGER_STORAGE_KEY)! };
}

const input = (i: number): LedgerInput => ({
  kind: "privileged",
  action: "quota.override_granted",
  actorId: "ada",
  subject: { kind: "quota", id: `q-${i}` },
  data: { limit: i }
});

describe("ledger append fast path (#392)", () => {
  it("normal: produces exactly the bytes a full re-serialization would, and the chain verifies", () => {
    const { ledger, blob } = setup();
    for (let i = 0; i < 50; i++) expect(ledger.append(input(i)).ok).toBe(true);

    expect(blob()).toBe(JSON.stringify(JSON.parse(blob())));
    expect(ledger.entries()).toHaveLength(50);
    expect(ledger.verify().ok).toBe(true);
  });

  it("failure: tampering with the stored tail after a cached append is still refused", () => {
    const { ledger, storage, blob } = setup();
    ledger.append(input(1));
    ledger.append(input(2));

    const stored = JSON.parse(blob());
    stored.entries[1].data.limit = 999;
    storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(stored));

    expect(ledger.append(input(3))).toEqual({ ok: false, code: "ledger_broken" });
  });

  it("failure: an unparseable blob written behind the cache is refused, not overwritten", () => {
    const { ledger, storage } = setup();
    ledger.append(input(1));
    storage.setItem(LEDGER_STORAGE_KEY, "{not json");

    expect(ledger.append(input(2))).toEqual({ ok: false, code: "ledger_broken" });
    expect(storage.getItem(LEDGER_STORAGE_KEY)).toBe("{not json");
  });

  it("recovery: appends after prune, reset and a second writer continue a valid chain", () => {
    const { ledger, storage, blob } = setup(5);
    for (let i = 0; i < 10; i++) ledger.append(input(i));
    expect(ledger.prune()).toBe(5);
    ledger.append(input(10));
    expect(ledger.verify().ok).toBe(true);
    expect(ledger.entries()).toHaveLength(6);

    // Another instance on the same storage (e.g. a second tab) writes in between.
    const other = createLedger({ storage, now: () => START + 999_000 });
    other.append(input(11));
    ledger.append(input(12));
    expect(ledger.verify().ok).toBe(true);
    expect(ledger.entries().map((e) => e.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);

    ledger.reset();
    ledger.append(input(13));
    expect(JSON.parse(blob()).entries).toHaveLength(1);
    expect(ledger.verify().ok).toBe(true);
  });

  it("mutating a returned entry cannot corrupt the next append", () => {
    const { ledger } = setup();
    const first = ledger.append(input(1));
    if (first.ok) (first.value as { hash: string }).hash = "f".repeat(64);
    expect(ledger.append(input(2)).ok).toBe(true);
    expect(ledger.verify().ok).toBe(true);
  });

  it("budget: append cost stays flat as the chain grows (small vs 3,000 entries)", async () => {
    // Relative, not absolute: CPU contention slows both samples alike. The old
    // full re-serialize made a 3,000-entry append ~20x a 200-entry one.
    const { ledger } = setup();
    const sample = () =>
      runLoad((i) => ledger.append(input(i)), { iterations: 200, concurrency: 1 });

    await sample(); // JIT warm-up; chain now 200
    const small = await sample();
    for (let i = 0; i < 2_600; i++) ledger.append(input(i));
    const large = await sample();

    expect(small.errors + large.errors).toBe(0);
    expect(large.p50Ms).toBeLessThan(small.p50Ms * 3 + 0.25);
    expect(ledger.verify().ok).toBe(true);
  });
});
