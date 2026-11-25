/**
 * Dependency degradation matrix and fallback behavior (#340).
 *
 * Normal path: healthy calls go straight through. Failure path: exhausted
 * retries fall back or fail with a safe message. Retry path: backoff, no retry
 * on invalid responses, circuit open / half-open recovery. Authorization:
 * operator overrides need `admin:health`.
 */

import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  createDegradationTracker,
  DEGRADATION_MATRIX,
  DEPENDENCY_IDS
} from "../degradation";

function setup(options: { failureThreshold?: number; recoveryWindowMs?: number } = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const tracker = createDegradationTracker({
    ...options,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  return { tracker, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}

function failing(error: unknown) {
  let calls = 0;
  const fn = () => {
    calls += 1;
    throw error;
  };
  return { fn, calls: () => calls };
}

const UNAVAILABLE = Object.assign(new Error("upstream 503"), { status: 503 });

describe("degradation matrix", () => {
  it("covers every dependency with a retry budget, a fallback and a safe message", () => {
    for (const id of DEPENDENCY_IDS) {
      const entry = DEGRADATION_MATRIX[id];
      expect(entry.id).toBe(id);
      expect(entry.retry.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(entry.failureModes.length).toBeGreaterThan(0);
      expect(entry.userMessage.length).toBeGreaterThan(0);
      // User-facing text never leaks hosts, status codes or stack detail.
      expect(entry.userMessage).not.toMatch(/https?:\/\/|\b[45]\d\d\b|Error:/);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEGRADATION_MATRIX)).toBe(true);
  });
});

describe("classifyFailure", () => {
  it("maps errors to failure modes without reading messages", () => {
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(classifyFailure({ status: 429 })).toBe("rate_limited");
    expect(classifyFailure({ response: { status: 404 } })).toBe("invalid_response");
    expect(classifyFailure(new SyntaxError("Unexpected token"))).toBe("invalid_response");
    expect(classifyFailure(UNAVAILABLE)).toBe("unavailable");
    expect(classifyFailure("boom")).toBe("unavailable");
  });
});

describe("callWithFallback", () => {
  it("returns the primary value and keeps the dependency healthy", async () => {
    const { tracker } = setup();
    const result = await tracker.callWithFallback("horizon", () => 42);
    expect(result).toEqual({ ok: true, value: { value: 42, source: "primary", attempts: 1 } });
    expect(tracker.state("horizon").level).toBe("healthy");
  });

  it("retries with exponential backoff, then serves the fallback", async () => {
    const { tracker, sleeps } = setup();
    const primary = failing(UNAVAILABLE);
    const result = await tracker.callWithFallback("horizon", primary.fn, { fallback: () => "cached" });

    expect(primary.calls()).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(result.ok && result.value).toMatchObject({
      value: "cached",
      source: "fallback",
      attempts: 3,
      userMessage: DEGRADATION_MATRIX.horizon.userMessage
    });
    expect(tracker.state("horizon")).toMatchObject({
      level: "degraded",
      consecutiveFailures: 1,
      lastFailureMode: "unavailable"
    });
  });

  it("does not retry an invalid response", async () => {
    const { tracker, sleeps } = setup();
    const primary = failing(new SyntaxError("bad json"));
    await tracker.callWithFallback("soroban_rpc", primary.fn);
    expect(primary.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("fails with a safe message when the matrix has no fallback", async () => {
    const { tracker } = setup();
    const result = await tracker.callWithFallback("stellar_toml", failing(UNAVAILABLE).fn, {
      fallback: () => "ignored"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("dependency_unavailable");
    expect(result.detail).toEqual({
      dependency: "stellar_toml",
      failureMode: "unavailable",
      strategy: "none",
      userMessage: DEGRADATION_MATRIX.stellar_toml.userMessage
    });
  });

  it("fails when no fallback was supplied, and when the fallback throws", async () => {
    const { tracker } = setup();
    const noFallback = await tracker.callWithFallback("friendbot", failing(UNAVAILABLE).fn);
    expect(noFallback.ok === false && noFallback.code).toBe("dependency_unavailable");

    const broken = await tracker.callWithFallback("browser_storage", failing(UNAVAILABLE).fn, {
      fallback: () => {
        throw new Error("no memory either");
      }
    });
    expect(broken.ok === false && broken.code).toBe("fallback_failed");
  });

  it("opens the circuit after the threshold, then probes once after the window", async () => {
    const { tracker, advance } = setup({ failureThreshold: 2, recoveryWindowMs: 10_000 });
    const primary = failing(UNAVAILABLE);
    await tracker.callWithFallback("freighter", primary.fn);
    await tracker.callWithFallback("freighter", primary.fn);
    expect(tracker.state("freighter").level).toBe("down");
    const callsWhenDown = primary.calls();

    // Open: the primary is not called at all, the fallback still works.
    const skipped = await tracker.callWithFallback("freighter", primary.fn, { fallback: () => "read-only" });
    expect(primary.calls()).toBe(callsWhenDown);
    expect(skipped.ok && skipped.value).toMatchObject({ source: "fallback", attempts: 0 });

    // Half-open: one probe, and a success closes the circuit.
    advance(10_000);
    const probe = await tracker.callWithFallback("freighter", () => "connected");
    expect(probe.ok && probe.value.source).toBe("primary");
    expect(tracker.state("freighter")).toMatchObject({ level: "healthy", consecutiveFailures: 0 });
  });

  it("allows a single probe attempt while half-open", async () => {
    const { tracker, advance } = setup({ failureThreshold: 1, recoveryWindowMs: 1_000 });
    await tracker.callWithFallback("horizon", failing(UNAVAILABLE).fn);
    advance(1_000);
    const probe = failing(UNAVAILABLE);
    await tracker.callWithFallback("horizon", probe.fn);
    expect(probe.calls()).toBe(1);
    expect(tracker.state("horizon").level).toBe("down");
  });
});

describe("operator overrides", () => {
  const maintainer = { role: "maintainer" as const, userId: "ops-7" };

  it("requires admin:health", () => {
    const { tracker } = setup();
    expect(tracker.override("horizon", "down", { role: "viewer" })).toEqual({
      ok: false,
      code: "override_forbidden"
    });
    expect(tracker.clearOverride("horizon", { role: "viewer" })).toEqual({
      ok: false,
      code: "override_forbidden"
    });
    expect(tracker.override("horizon", "down", { role: "service" }).ok).toBe(true);
  });

  it("forcing down skips the primary until cleared", async () => {
    const { tracker } = setup();
    expect(tracker.override("soroban_rpc", "down", maintainer).ok).toBe(true);
    let called = false;
    const result = await tracker.callWithFallback(
      "soroban_rpc",
      () => {
        called = true;
        return 1;
      },
      { fallback: () => 0 }
    );
    expect(called).toBe(false);
    expect(result.ok && result.value.source).toBe("fallback");
    expect(tracker.state("soroban_rpc").override).toMatchObject({ level: "down", by: "ops-7" });

    tracker.clearOverride("soroban_rpc", maintainer);
    expect(tracker.state("soroban_rpc").level).toBe("healthy");
  });

  it("forcing healthy keeps calling a dependency that looks down", async () => {
    const { tracker } = setup({ failureThreshold: 1, recoveryWindowMs: 60_000 });
    await tracker.callWithFallback("friendbot", failing(UNAVAILABLE).fn);
    expect(tracker.state("friendbot").level).toBe("down");
    tracker.override("friendbot", "healthy", maintainer);
    const result = await tracker.callWithFallback("friendbot", () => "funded");
    expect(result.ok && result.value.source).toBe("primary");
  });

  it("expires a timed override by itself", () => {
    const { tracker, advance, now } = setup();
    tracker.override("horizon", "down", maintainer, now() + 5_000);
    expect(tracker.state("horizon").level).toBe("down");
    advance(5_000);
    expect(tracker.state("horizon")).toMatchObject({ level: "healthy", override: null });
  });

  it("rejects an override that has already expired", () => {
    const { tracker, now } = setup();
    expect(tracker.override("horizon", "down", maintainer, now()).ok).toBe(false);
  });
});
