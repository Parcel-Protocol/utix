import { describe, expect, it, beforeEach } from "vitest";
import {
  configureTelemetryProtectionAuthorized,
  createProtectionSnapshot,
  protectTelemetry,
  resetTelemetryProtection,
  restoreProtectionSnapshot
} from "@/core/telemetry/protection";
import type { AuthContext } from "@/core/auth/middleware";

describe("High-Cardinality Telemetry Redaction & Sampling (Issue #345)", () => {
  beforeEach(() => {
    resetTelemetryProtection();
  });

  it("normal path: redacts secrets and normalizes high-cardinality transaction hashes and UUIDs", () => {
    const rawEvent = {
      op: "horizon.tx_submit",
      user: "GBBD6W3NZUBY7J572J45A75Z7P4C0B634S8X2A7X6M27B2B642C3N444",
      token: "secret_api_key_12345",
      txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      requestId: "c381ec80-2a82-4fa2-bc49-3e3e481b7e28",
      seedKey: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    };

    const protectedEvent = protectTelemetry(rawEvent);
    expect(protectedEvent.sampled).toBe(true);
    expect(protectedEvent.event).toBeDefined();

    const ev = protectedEvent.event!;
    // Secret fields scrubbed
    expect(ev.token).toBe("[REDACTED]");
    expect(ev.seedKey).toBe("[REDACTED]");

    // High cardinality values masked
    expect(ev.txHash).toBe("[HIGH_CARDINALITY_TRUNCATED]");
    expect(ev.requestId).toBe("[HIGH_CARDINALITY_TRUNCATED]");
    expect(protectedEvent.highCardinalityFields).toContain("txHash");
    expect(protectedEvent.highCardinalityFields).toContain("requestId");
  });

  it("failure priority path: failure events are always 100% sampled regardless of sample rate", () => {
    const failureEvent = {
      op: "payment.submit",
      result: "failure",
      errorCode: "tx_insufficient_balance",
      correlationId: "corr-fail-999"
    };

    // Even with a 0% sample rate, failure events must NEVER be dropped
    const protectedResult = protectTelemetry(failureEvent, {
      sampleRate: 0.0,
      priorityFailureSampling: true
    });

    expect(protectedResult.sampled).toBe(true);
    expect(protectedResult.event).toBeDefined();
    expect(protectedResult.event?.errorCode).toBe("tx_insufficient_balance");
  });

  it("retry & deterministic sampling path: events sharing correlationId have consistent sampling decisions", () => {
    const correlationId = "corr-deterministic-trace-123";

    const event1 = { op: "step.prepare", correlationId, sampleRate: 0.5 };
    const event2 = { op: "step.execute", correlationId, sampleRate: 0.5 };

    const sample1 = protectTelemetry(event1, { sampleRate: 0.5, deterministicSampling: true });
    const sample2 = protectTelemetry(event2, { sampleRate: 0.5, deterministicSampling: true });

    // Both events must receive identical sampling decision
    expect(sample1.sampled).toBe(sample2.sampled);
  });

  it("authorization path: requires elevated privileges to configure telemetry protection", () => {
    const viewerAuth: AuthContext = { role: "viewer", userId: "v-1" };
    const maintainerAuth: AuthContext = { role: "maintainer", userId: "m-1" };

    const denied = configureTelemetryProtectionAuthorized(viewerAuth, { sampleRate: 0.1 });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("permission_denied");

    const allowed = configureTelemetryProtectionAuthorized(maintainerAuth, { sampleRate: 0.25 });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.sampleRate).toBe(0.25);
  });

  it("rollback path: snapshots configuration and restores previous state upon rollback", () => {
    const maintainerAuth: AuthContext = { role: "maintainer" };

    // Baseline configuration
    configureTelemetryProtectionAuthorized(maintainerAuth, { sampleRate: 0.8 });
    const snapshot = createProtectionSnapshot();
    expect(snapshot.sampleRate).toBe(0.8);

    // Update configuration
    configureTelemetryProtectionAuthorized(maintainerAuth, { sampleRate: 0.05 });
    expect(createProtectionSnapshot().sampleRate).toBe(0.05);

    // Rollback configuration
    restoreProtectionSnapshot(snapshot);
    expect(createProtectionSnapshot().sampleRate).toBe(0.8);
  });

  it("cardinality bounding: marks field as high-cardinality when distinct values exceed threshold", () => {
    const fieldName = "customTag";

    // Feed 50 distinct values
    for (let i = 0; i < 50; i++) {
      protectTelemetry({ [fieldName]: `val-${i}` }, { maxDistinctValuesPerField: 50 });
    }

    // 51st distinct value should now be detected as high cardinality
    const res = protectTelemetry({ [fieldName]: "val-overflow" }, { maxDistinctValuesPerField: 50 });
    expect(res.event?.[fieldName]).toBe("[HIGH_CARDINALITY_TRUNCATED]");
  });
});

