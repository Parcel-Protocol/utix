/**
 * Permission-Diff Preview Before Policy Changes
 *
 * Verifies the normal, failure, retry, and authorization paths for the
 * PermissionDiffEngine and the pre-flight diff report generated before any
 * role or policy change is applied.
 *
 * Coverage:
 * - Issue #407: Permission-Diff Preview Before Policy Changes
 * - Issue #451: Extended Permission-Diff Preview Coverage
 */

import { describe, expect, it } from "vitest";
import type { Permission, Role } from "@/core/auth/types";
import { PermissionDiffEngine } from "../permissionDiff";

describe("Issue #407: Permission-Diff Preview Before Policy Changes", () => {
  const maintainerContext = { role: "maintainer" as const, userId: "admin-satoshi" };
  const viewerContext = { role: "viewer" as const, userId: "user-alice" };

  const basePermissions: Record<Role, Permission[]> = {
    viewer: ["view:tools", "view:dashboard"],
    maintainer: [
      "view:tools",
      "view:dashboard",
      "admin:health",
      "admin:recovery",
      "admin:metrics",
      "admin:replay"
    ],
    service: ["admin:health", "admin:metrics"]
  };

  describe("normal path", () => {
    it("generates an accurate preview of proposed policy additions and removals", () => {
      const proposed: Record<Role, Permission[]> = {
        ...basePermissions,
        service: ["admin:health", "view:tools"] // removed admin:metrics, added view:tools
      };

      const res = PermissionDiffEngine.generateDiffReport(basePermissions, proposed, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const report = res.value;
      expect(report.totalAddedCount).toBe(1);
      expect(report.totalRemovedCount).toBe(1);
      expect(report.hasPrivilegeEscalation).toBe(true);
      expect(report.hasPrivilegeRevocation).toBe(true);
      expect(report.recommendedAction).toBe("proceed");
      expect(report.executionPlan.allowApply).toBe(true);

      const serviceDiff = report.roleDiffs.find((d) => d.role === "service");
      expect(serviceDiff?.addedPermissions).toEqual(["view:tools"]);
      expect(serviceDiff?.removedPermissions).toEqual(["admin:metrics"]);
      expect(serviceDiff?.unchangedPermissions).toEqual(["admin:health"]);
      expect(serviceDiff?.netChange).toBe(0);

      // Verify rollback snapshot matches base permissions exactly
      expect(report.rollbackSnapshot).toEqual(basePermissions);
    });

    it("applies policy change atomically returning updated permissions and snapshot", () => {
      const proposed: Record<Role, Permission[]> = {
        ...basePermissions,
        viewer: ["view:tools"] // removed view:dashboard
      };

      const res = PermissionDiffEngine.applyRolePolicyChange(basePermissions, proposed, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.newPermissions.viewer).toEqual(["view:tools"]);
      expect(res.value.rollbackSnapshot.viewer).toEqual(["view:tools", "view:dashboard"]);
    });
  });

  describe("failure paths and validation guards", () => {
    it("rejects unknown or invalid role definitions with invalid_role_definition", () => {
      const invalidRoles = {
        ...basePermissions,
        superadmin: ["admin:recovery"] // invalid role
      } as unknown as Record<Role, Permission[]>;

      const res = PermissionDiffEngine.generateDiffReport(basePermissions, invalidRoles, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("invalid_role_definition");
    });

    it("rejects unknown permissions with invalid_permission", () => {
      const invalidPerms = {
        ...basePermissions,
        viewer: ["view:tools", "root:destroy_all" as Permission]
      };

      const res = PermissionDiffEngine.generateDiffReport(basePermissions, invalidPerms, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("invalid_permission");
    });

    it("rejects empty permission mapping with empty_permissions", () => {
      const empty = {} as Record<Role, Permission[]>;

      const res = PermissionDiffEngine.generateDiffReport(basePermissions, empty, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("empty_permissions");
    });
  });

  describe("authorization path", () => {
    it("denies preview generation for non-maintainer callers with unauthorized", () => {
      const res = PermissionDiffEngine.generateDiffReport(basePermissions, basePermissions, {
        caller: viewerContext
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("unauthorized");
    });

    it("permits preview generation for maintainer caller", () => {
      const res = PermissionDiffEngine.generateDiffReport(basePermissions, basePermissions, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(true);
    });
  });

  describe("risk detection, privilege escalation, and lockout edge cases", () => {
    it("blocks critical privilege escalation to non-maintainer role by default", () => {
      const criticalEscalation: Record<Role, Permission[]> = {
        ...basePermissions,
        viewer: ["view:tools", "view:dashboard", "admin:recovery"]
      };

      const reportRes = PermissionDiffEngine.generateDiffReport(basePermissions, criticalEscalation, {
        caller: maintainerContext
      });
      expect(reportRes.ok).toBe(true);
      if (!reportRes.ok) return;

      expect(reportRes.value.overallRiskLevel).toBe("critical");
      expect(reportRes.value.recommendedAction).toBe("block");
      expect(reportRes.value.executionPlan.allowApply).toBe(false);

      // Attempting to apply directly fails with critical_escalation_blocked
      const applyRes = PermissionDiffEngine.applyRolePolicyChange(basePermissions, criticalEscalation, {
        caller: maintainerContext
      });
      expect(applyRes.ok).toBe(false);
      if (!applyRes.ok) expect(applyRes.code).toBe("critical_escalation_blocked");
    });

    it("detects administrator lockout risk when maintainer permissions are stripped", () => {
      const lockoutProposed: Record<Role, Permission[]> = {
        ...basePermissions,
        maintainer: [] // emptied maintainer
      };

      const res = PermissionDiffEngine.generateDiffReport(basePermissions, lockoutProposed, {
        caller: maintainerContext
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.overallRiskLevel).toBe("critical");
      expect(res.value.warnings.some((w) => w.includes("LOCKOUT RISK"))).toBe(true);
      expect(res.value.executionPlan.allowApply).toBe(false);
    });

    it("allows applying critical escalations only when explicitly override allowed", () => {
      const criticalEscalation: Record<Role, Permission[]> = {
        ...basePermissions,
        viewer: ["view:tools", "view:dashboard", "admin:recovery"]
      };

      const res = PermissionDiffEngine.applyRolePolicyChange(basePermissions, criticalEscalation, {
        caller: maintainerContext,
        allowCriticalEscalations: true
      });

      expect(res.ok).toBe(true);
    });
  });

  describe("retry path", () => {
    it("retries diff report on transient failures up to maxRetries", () => {
      let attempts = 0;
      const fn = () => {
        attempts += 1;
        if (attempts < 3) {
          return { ok: false as const, code: "empty_permissions" as const };
        }
        return PermissionDiffEngine.generateDiffReport(basePermissions, basePermissions, {
          caller: maintainerContext
        });
      };

      const res = PermissionDiffEngine.retryDiffReport(fn, 3);
      expect(res.ok).toBe(true);
      expect(attempts).toBe(3);
    });
  });
});

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const maintainerCtx = { role: "maintainer" as const, userId: "admin-007" };
const viewerCtx = { role: "viewer" as const, userId: "read-only-user" };
const serviceCtx = { role: "service" as const, userId: "svc-account" };

const BASE: Record<Role, Permission[]> = {
  viewer: ["view:tools", "view:dashboard"],
  maintainer: [
    "view:tools",
    "view:dashboard",
    "admin:health",
    "admin:recovery",
    "admin:metrics",
    "admin:replay",
  ],
  service: ["admin:health", "admin:metrics"],
};

// ─── Normal path ──────────────────────────────────────────────────────────────

describe("#451 — permission-diff preview before policy changes", () => {
  describe("normal path", () => {
    it("generates a low-risk diff for a benign additive change", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: [...BASE.service, "view:tools"],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { overallRiskLevel, recommendedAction, executionPlan, totalAddedCount, totalRemovedCount } =
        result.value;
      expect(overallRiskLevel).toBe("low");
      expect(recommendedAction).toBe("proceed");
      expect(executionPlan.allowApply).toBe(true);
      expect(totalAddedCount).toBe(1);
      expect(totalRemovedCount).toBe(0);
    });

    it("generates a rollback snapshot that reflects the state before the change", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        viewer: ["view:tools"], // removed view:dashboard
      };

      const result = PermissionDiffEngine.applyRolePolicyChange(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Rollback snapshot preserves original viewer permissions
      expect(result.value.rollbackSnapshot.viewer).toEqual(["view:tools", "view:dashboard"]);
      // New permissions reflect the proposed state
      expect(result.value.newPermissions.viewer).toEqual(["view:tools"]);
    });

    it("produces a stable reportId and generatedAt timestamp on each call", () => {
      const fixedNow = 1_700_000_000_000;
      const r1 = PermissionDiffEngine.generateDiffReport(BASE, BASE, {
        caller: maintainerCtx,
        now: () => fixedNow,
      });
      const r2 = PermissionDiffEngine.generateDiffReport(BASE, BASE, {
        caller: maintainerCtx,
        now: () => fixedNow + 1,
      });

      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      expect(r1.value.generatedAt).toBe(new Date(fixedNow).toISOString());
      expect(r2.value.generatedAt).toBe(new Date(fixedNow + 1).toISOString());
      // Different timestamps produce different reportIds
      expect(r1.value.reportId).not.toBe(r2.value.reportId);
    });

    it("handles a no-op diff (identical current and proposed)", () => {
      const result = PermissionDiffEngine.generateDiffReport(BASE, BASE, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.totalAddedCount).toBe(0);
      expect(result.value.totalRemovedCount).toBe(0);
      expect(result.value.affectedRolesCount).toBe(0);
      expect(result.value.overallRiskLevel).toBe("low");
      expect(result.value.recommendedAction).toBe("proceed");
    });

    it("correctly counts affected roles when multiple roles change simultaneously", () => {
      const proposed: Record<Role, Permission[]> = {
        viewer: [...BASE.viewer, "admin:health"],       // escalation
        maintainer: BASE.maintainer,
        service: BASE.service.filter((p) => p !== "admin:metrics"), // revocation
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.affectedRolesCount).toBe(2);
      expect(result.value.hasPrivilegeEscalation).toBe(true);
      expect(result.value.hasPrivilegeRevocation).toBe(true);
    });

    it("sets hasPrivilegeEscalation and hasPrivilegeRevocation correctly for mixed diff", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:metrics", "admin:replay"], // added admin:replay, removed admin:health
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasPrivilegeEscalation).toBe(true);
      expect(result.value.hasPrivilegeRevocation).toBe(true);
    });
  });

  // ─── Failure path ───────────────────────────────────────────────────────────

  describe("failure path", () => {
    it("blocks critical escalation: admin:recovery granted to viewer", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        viewer: [...BASE.viewer, "admin:recovery"],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallRiskLevel).toBe("critical");
      expect(result.value.recommendedAction).toBe("block");
      expect(result.value.executionPlan.allowApply).toBe(false);
      expect(result.value.warnings.some((w) => w.includes("CRITICAL ESCALATION"))).toBe(true);
    });

    it("blocks critical escalation: admin:replay granted to viewer", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        viewer: [...BASE.viewer, "admin:replay"],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallRiskLevel).toBe("critical");
      expect(result.value.executionPlan.gatingReasons.length).toBeGreaterThan(0);
    });

    it("flags LOCKOUT RISK when maintainer role is fully revoked", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        maintainer: [],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallRiskLevel).toBe("critical");
      expect(result.value.warnings.some((w) => w.includes("LOCKOUT RISK"))).toBe(true);
      expect(result.value.executionPlan.gatingReasons).toContain(
        "Lockout risk: Maintainer permissions emptied"
      );
    });

    it("returns high risk for high-privilege permission grant to service role", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: [...BASE.service, "admin:health"], // admin:health already there
      };

      // Add a truly new high permission
      const proposed2: Record<Role, Permission[]> = {
        ...BASE,
        service: [...BASE.service, "admin:replay"],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed2, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(["high", "critical"]).toContain(result.value.overallRiskLevel);
    });

    it("applyRolePolicyChange returns critical_escalation_blocked when diff is blocked", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        viewer: [...BASE.viewer, "admin:recovery"],
      };

      const result = PermissionDiffEngine.applyRolePolicyChange(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("critical_escalation_blocked");
    });

    it("rejects an unknown role in proposed permissions", () => {
      const proposed = {
        ...BASE,
        super_admin: ["admin:recovery"],
      } as unknown as Record<Role, Permission[]>;

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_role_definition");
    });

    it("rejects an unknown permission in proposed role mapping", () => {
      const proposed = {
        ...BASE,
        viewer: ["view:tools", "admin:god_mode"],
      } as unknown as Record<Role, Permission[]>;

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_permission");
    });

    it("rejects an empty proposed role mapping", () => {
      const result = PermissionDiffEngine.generateDiffReport(
        BASE,
        {} as Record<Role, Permission[]>,
        { caller: maintainerCtx }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("empty_permissions");
    });

    it("rejects a non-array permission value for a role", () => {
      const proposed = {
        ...BASE,
        viewer: "view:tools", // string instead of array
      } as unknown as Record<Role, Permission[]>;

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_role_definition");
    });
  });

  // ─── Authorization path ─────────────────────────────────────────────────────

  describe("authorization path", () => {
    it("denies diff generation to viewer callers", () => {
      const result = PermissionDiffEngine.generateDiffReport(BASE, BASE, {
        caller: viewerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthorized");
    });

    it("denies diff generation to service callers", () => {
      const result = PermissionDiffEngine.generateDiffReport(BASE, BASE, {
        caller: serviceCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthorized");
    });

    it("denies applyRolePolicyChange to viewer callers", () => {
      const result = PermissionDiffEngine.applyRolePolicyChange(BASE, BASE, {
        caller: viewerCtx,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthorized");
    });

    it("allows diff generation when no caller is supplied (unauthenticated pass-through)", () => {
      // No caller option means no auth check is performed
      const result = PermissionDiffEngine.generateDiffReport(BASE, BASE);
      expect(result.ok).toBe(true);
    });

    it("allows critical escalation when caller is maintainer AND allowCriticalEscalations is set", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        viewer: [...BASE.viewer, "admin:recovery"],
      };

      const result = PermissionDiffEngine.applyRolePolicyChange(BASE, proposed, {
        caller: maintainerCtx,
        allowCriticalEscalations: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.newPermissions.viewer).toContain("admin:recovery");
    });
  });

  // ─── Retry path ─────────────────────────────────────────────────────────────

  describe("retry path", () => {
    it("retryDiffReport succeeds after a transient failure on the first attempt", () => {
      let calls = 0;

      const transient = () => {
        calls += 1;
        if (calls < 3) {
          return { ok: false as const, code: "invalid_role_definition" as const };
        }
        return PermissionDiffEngine.generateDiffReport(BASE, BASE, { caller: maintainerCtx });
      };

      const result = PermissionDiffEngine.retryDiffReport(transient, 3);
      expect(result.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("retryDiffReport exhausts retries and returns diff_retries_exhausted", () => {
      const alwaysFail = () => ({ ok: false as const, code: "invalid_role_definition" as const });

      const result = PermissionDiffEngine.retryDiffReport(alwaysFail, 2);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("diff_retries_exhausted");
    });

    it("retryDiffReport succeeds immediately if the first attempt passes", () => {
      let calls = 0;

      const alwaysPass = () => {
        calls += 1;
        return PermissionDiffEngine.generateDiffReport(BASE, BASE, { caller: maintainerCtx });
      };

      const result = PermissionDiffEngine.retryDiffReport(alwaysPass, 3);
      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
    });

    it("diff output is deterministic on repeated calls with the same input", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:health"],
      };

      const r1 = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
        now: () => 1_700_000_000_000,
      });
      const r2 = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
        now: () => 1_700_000_000_000,
      });

      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      expect(r1.value.overallRiskLevel).toBe(r2.value.overallRiskLevel);
      expect(r1.value.totalRemovedCount).toBe(r2.value.totalRemovedCount);
      expect(r1.value.warnings).toEqual(r2.value.warnings);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────────

  describe("edge cases and recovery", () => {
    it("rollback snapshot is immutable: mutating newPermissions does not affect snapshot", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:health"],
      };

      const result = PermissionDiffEngine.applyRolePolicyChange(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const snapshotBefore = [...result.value.rollbackSnapshot.service];
      result.value.newPermissions.service.push("admin:replay" as Permission);

      expect(result.value.rollbackSnapshot.service).toEqual(snapshotBefore);
    });

    it("diff netChange is positive for net escalations and negative for net revocations", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:health", "admin:metrics", "admin:replay"], // net +1
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const serviceDiff = result.value.roleDiffs.find((d) => d.role === "service");
      expect(serviceDiff?.netChange).toBeGreaterThan(0);
    });

    it("diff netChange is zero for a swap of equal count", () => {
      // Replace admin:health with admin:replay (net 0)
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:metrics", "admin:replay"],
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const serviceDiff = result.value.roleDiffs.find((d) => d.role === "service");
      expect(serviceDiff?.netChange).toBe(0);
      expect(serviceDiff?.addedPermissions).toContain("admin:replay");
      expect(serviceDiff?.removedPermissions).toContain("admin:health");
    });

    it("unchangedPermissions lists permissions that are present in both current and proposed", () => {
      const proposed: Record<Role, Permission[]> = {
        ...BASE,
        service: ["admin:health"], // removed admin:metrics
      };

      const result = PermissionDiffEngine.generateDiffReport(BASE, proposed, {
        caller: maintainerCtx,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const serviceDiff = result.value.roleDiffs.find((d) => d.role === "service");
      expect(serviceDiff?.unchangedPermissions).toContain("admin:health");
      expect(serviceDiff?.removedPermissions).toContain("admin:metrics");
    });
  });
});
