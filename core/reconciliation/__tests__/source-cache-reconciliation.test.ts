/**
 * Tests for source vs cached state reconciliation (#332).
 */

import { describe, expect, it } from "vitest";
import {
  reconcileSourceAndCache,
  balancesEqual,
  prioritisedFindings,
  type SourceEntry,
  type CachedEntry,
  type SourceCacheOptions,
} from "../source-cache-reconciliation";

const NOW = 1_770_000_000_000;
const FIVE_MIN = 5 * 60_000;

function src(account: string, asset: string, balance: string, ledgerSequence = 1000): SourceEntry {
  return { account, asset, balance, ledgerSequence };
}

function cached(account: string, asset: string, balance: string, ageMs = 0): CachedEntry {
  return {
    account,
    asset,
    balance,
    cachedAt: new Date(NOW - ageMs).toISOString(),
  };
}

const opts: SourceCacheOptions = { now: NOW, staleThresholdMs: FIVE_MIN };

// ─────────────────────────────────────────────────────────────────────────────
// balancesEqual
// ─────────────────────────────────────────────────────────────────────────────

describe("balancesEqual (#332)", () => {
  it("equal amounts with same precision", () => expect(balancesEqual("100.00", "100.00")).toBe(true));
  it("equal amounts with different precision", () => expect(balancesEqual("1.0", "1.00")).toBe(true));
  it("strips trailing zeros correctly", () => expect(balancesEqual("50.1000000", "50.1")).toBe(true));
  it("detects actual mismatch", () => expect(balancesEqual("100.00", "100.01")).toBe(false));
  it("handles zero", () => expect(balancesEqual("0", "0.0000000")).toBe(true));
  it("handles large amounts", () => expect(balancesEqual("9999999.9999999", "9999999.9999999")).toBe(true));
});

// ─────────────────────────────────────────────────────────────────────────────
// No drift
// ─────────────────────────────────────────────────────────────────────────────

describe("no drift (#332)", () => {
  it("returns drifted:false when source and cache agree", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.00")],
      [cached("GABC", "USDC:GAAA", "100.00", 1_000)],
      opts
    );
    expect(result.drifted).toBe(false);
  });

  it("returns drifted:false for empty inputs", () => {
    const result = reconcileSourceAndCache([], [], opts);
    expect(result.drifted).toBe(false);
  });

  it("includes totalChecked", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "10.00")],
      [cached("GABC", "USDC:GAAA", "10.00")],
      opts
    );
    expect(result.totalChecked).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cache_missing
// ─────────────────────────────────────────────────────────────────────────────

describe("cache_missing (#332)", () => {
  it("flags a source entry with no matching cache entry", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.00", 1001)],
      [],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.missing).toHaveLength(1);
    expect(result.drift.missing[0]).toMatchObject({
      kind: "cache_missing",
      account: "GABC",
      asset: "USDC:GAAA",
      sourceBalance: "100.00",
      sourceSequence: 1001,
    });
  });

  it("reports one finding per missing entry", () => {
    const result = reconcileSourceAndCache(
      [
        src("GABC", "USDC:GAAA", "100.00"),
        src("GXYZ", "XLM:native", "50.00"),
      ],
      [],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.missing).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// source_missing (orphan cache)
// ─────────────────────────────────────────────────────────────────────────────

describe("source_missing (#332)", () => {
  it("flags a cache entry that has no source counterpart", () => {
    const result = reconcileSourceAndCache(
      [],
      [cached("GORPH", "USDC:GAAA", "75.00", 2_000)],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.orphans).toHaveLength(1);
    expect(result.drift.orphans[0]).toMatchObject({
      kind: "source_missing",
      account: "GORPH",
      asset: "USDC:GAAA",
      cachedBalance: "75.00",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// amount_mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("amount_mismatch (#332)", () => {
  it("flags amounts that differ between source and cache", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "200.00", 1500)],
      [cached("GABC", "USDC:GAAA", "100.00", 1_000)],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.mismatches).toHaveLength(1);
    expect(result.drift.mismatches[0]).toMatchObject({
      kind: "amount_mismatch",
      account: "GABC",
      sourceBalance: "200.00",
      cachedBalance: "100.00",
      sourceSequence: 1500,
    });
  });

  it("does not flag matching amounts even with different precision", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.0")],
      [cached("GABC", "USDC:GAAA", "100.00")],
      { ...opts, staleThresholdMs: 0 } // disable stale check
    );
    expect(result.drifted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// metadata_stale
// ─────────────────────────────────────────────────────────────────────────────

describe("metadata_stale (#332)", () => {
  it("flags a cache entry that is older than the stale threshold", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.00")],
      [cached("GABC", "USDC:GAAA", "100.00", FIVE_MIN + 1)],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.stale).toHaveLength(1);
    expect(result.drift.stale[0]).toMatchObject({
      kind: "metadata_stale",
      account: "GABC",
      ageMs: FIVE_MIN + 1,
      thresholdMs: FIVE_MIN,
    });
  });

  it("does not flag a cache entry that is within the threshold", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.00")],
      [cached("GABC", "USDC:GAAA", "100.00", FIVE_MIN - 1)],
      opts
    );
    expect(result.drifted).toBe(false);
  });

  it("stale check disabled when staleThresholdMs is 0", () => {
    const result = reconcileSourceAndCache(
      [src("GABC", "USDC:GAAA", "100.00")],
      [cached("GABC", "USDC:GAAA", "100.00", FIVE_MIN * 100)],
      { now: NOW, staleThresholdMs: 0 }
    );
    expect(result.drifted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mixed drift
// ─────────────────────────────────────────────────────────────────────────────

describe("mixed drift (#332)", () => {
  it("reports all four drift types in one result", () => {
    const result = reconcileSourceAndCache(
      [
        src("G1", "USDC:GAAA", "100.00"),        // matched but stale
        src("G2", "USDC:GAAA", "200.00"),        // amount mismatch
        src("G3", "USDC:GAAA", "50.00"),         // cache missing
      ],
      [
        cached("G1", "USDC:GAAA", "100.00", FIVE_MIN + 1), // stale
        cached("G2", "USDC:GAAA", "999.00", 1_000),        // mismatch
        cached("G4", "USDC:GAAA", "10.00", 500),           // orphan
      ],
      opts
    );
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.drift.missing).toHaveLength(1);
    expect(result.drift.orphans).toHaveLength(1);
    expect(result.drift.mismatches).toHaveLength(1);
    expect(result.drift.stale).toHaveLength(1);
    expect(result.findings).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prioritisedFindings
// ─────────────────────────────────────────────────────────────────────────────

describe("prioritisedFindings (#332)", () => {
  it("returns empty array when no drift", () => {
    const result = reconcileSourceAndCache([], [], opts);
    expect(prioritisedFindings(result)).toHaveLength(0);
  });

  it("mismatches come before missing which come before orphans", () => {
    const result = reconcileSourceAndCache(
      [src("G1", "A", "1.00"), src("G2", "B", "2.00")],
      [cached("G1", "A", "9.00"), cached("G3", "C", "3.00")],
      { ...opts, staleThresholdMs: 0 }
    );
    if (!result.drifted) return;
    const pf = prioritisedFindings(result);
    expect(pf[0]!.kind).toBe("amount_mismatch");
    expect(pf[1]!.kind).toBe("cache_missing");
    expect(pf[2]!.kind).toBe("source_missing");
  });
});
