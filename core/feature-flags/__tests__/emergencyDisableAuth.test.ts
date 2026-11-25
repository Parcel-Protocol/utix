import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizedClearEmergencyDisable,
  authorizedEmergencyDisable,
  createRolloutGuard
} from "@/core/feature-flags/rollout-guard";
import { isFeatureEnabled, resetRolloutEngine } from "@/core/feature-flags/flags";

const maintainer = { role: "maintainer" as const, userId: "maintainer:ADMIN" };
const viewer = { role: "viewer" as const, userId: "viewer:EVE" };
const service = { role: "service" as const, userId: "svc:metrics" };
const FLAG = "policySimulationPreview";

describe("Issue #458: authorized emergency disablement", () => {
  beforeEach(() => {
    resetRolloutEngine();
  });
  afterEach(() => resetRolloutEngine());

  it("normal: a maintainer disables and later re-enables a flag", () => {
    expect(isFeatureEnabled(FLAG)).toBe(true);

    const res = authorizedEmergencyDisable(FLAG, maintainer, { reason: "bad deploy", now: 1_700_000_000_000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.alreadyActive).toBe(false);
      expect(res.value.record.triggeredBy).toBe("maintainer:ADMIN");
    }
    expect(isFeatureEnabled(FLAG)).toBe(false);

    const cleared = authorizedClearEmergencyDisable(FLAG, maintainer);
    expect(cleared).toEqual({ ok: true, value: true });
    expect(isFeatureEnabled(FLAG)).toBe(true);
  });

  it("authorization: viewers and services cannot trigger or clear the kill switch", () => {
    for (const auth of [viewer, service]) {
      const res = authorizedEmergencyDisable(FLAG, auth, { reason: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("permission_denied");
    }
    expect(isFeatureEnabled(FLAG)).toBe(true);

    authorizedEmergencyDisable(FLAG, maintainer, { reason: "incident" });
    expect(authorizedClearEmergencyDisable(FLAG, viewer).ok).toBe(false);
    expect(isFeatureEnabled(FLAG)).toBe(false);
  });

  it("failure: a blank reason is refused and nothing changes", () => {
    const res = authorizedEmergencyDisable(FLAG, maintainer, { reason: "   " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("reason_required");
    expect(isFeatureEnabled(FLAG)).toBe(true);
  });

  it("retry: re-triggering keeps the original record instead of overwriting it", () => {
    authorizedEmergencyDisable(FLAG, maintainer, { reason: "first", now: 1_700_000_000_000 });
    const retry = authorizedEmergencyDisable(FLAG, { role: "maintainer", userId: "maintainer:OTHER" }, {
      reason: "second",
      now: 1_700_000_999_000
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.alreadyActive).toBe(true);
      expect(retry.value.record.reason).toBe("first");
      expect(retry.value.record.triggeredBy).toBe("maintainer:ADMIN");
    }
  });

  it("retry: clearing an already-clear flag is a safe no-op", () => {
    expect(authorizedClearEmergencyDisable(FLAG, maintainer)).toEqual({ ok: true, value: false });
  });

  it("an operator disable during a guarded rollout wins over the canary, and clearing it does not untrip the guard", () => {
    const guard = createRolloutGuard({ flag: FLAG, riskTier: "high", percentage: 100 });
    expect(guard.isEnabled({ subjectId: "G-1" })).toBe(true);

    authorizedEmergencyDisable(FLAG, maintainer, { reason: "manual stop" });
    expect(guard.isEnabled({ subjectId: "G-1" })).toBe(false);

    authorizedClearEmergencyDisable(FLAG, maintainer);
    expect(guard.isEnabled({ subjectId: "G-1" })).toBe(true);

    guard.manualRollback("automated stop");
    authorizedClearEmergencyDisable(FLAG, maintainer);
    // Flag itself is re-enabled, but the tripped guard stays closed until replaced.
    expect(isFeatureEnabled(FLAG)).toBe(true);
    expect(guard.isEnabled({ subjectId: "G-1" })).toBe(false);
  });
});
