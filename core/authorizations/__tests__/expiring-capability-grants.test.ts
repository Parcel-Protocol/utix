import { describe, expect, it } from "vitest";
import {
  consumeCapabilityGrant,
  createMemoryCapabilityStore,
  executeWithCapability,
  issueCapabilityGrant,
  revokeCapabilityGrant,
  verifyCapabilityGrant
} from "../capabilities";

describe("expiring capability grants for sensitive actions (#434)", () => {
  const maintainer = { id: "maint-1", role: "maintainer" as const };
  const granteeUser = "operator-99";
  const sensitiveAction = "admin:emergency_recovery";

  describe("normal path", () => {
    it("issues, verifies, and consumes single-use capability grant before expiry", () => {
      const store = createMemoryCapabilityStore();

      const issueRes = issueCapabilityGrant(store, {
        grantor: maintainer.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 60_000,
        maxUses: 2,
        actorRole: maintainer.role
      });

      expect(issueRes.ok).toBe(true);
      if (!issueRes.ok) return;

      const grantId = issueRes.value.id;

      // Verify unconsumed grant
      const checkRes = verifyCapabilityGrant(store, {
        id: grantId,
        grantee: granteeUser,
        capability: sensitiveAction
      });
      expect(checkRes.ok).toBe(true);

      // Consume first use
      const consume1 = consumeCapabilityGrant(store, {
        id: grantId,
        grantee: granteeUser,
        capability: sensitiveAction
      });
      expect(consume1.ok).toBe(true);
      if (consume1.ok) {
        expect(consume1.value.remainingUses).toBe(1);
      }

      // Consume second use
      const consume2 = consumeCapabilityGrant(store, {
        id: grantId,
        grantee: granteeUser,
        capability: sensitiveAction
      });
      expect(consume2.ok).toBe(true);
      if (consume2.ok) {
        expect(consume2.value.remainingUses).toBe(0);
      }
    });
  });

  describe("failure & expiry path", () => {
    it("rejects unauthorized grant issuance from non-maintainer role", () => {
      const store = createMemoryCapabilityStore();

      const res = issueCapabilityGrant(store, {
        grantor: "untrusted-user",
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 60_000,
        actorRole: "viewer"
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("grantor_unauthorized");
      }
    });

    it("rejects expired capability grants", () => {
      const store = createMemoryCapabilityStore();

      const issueRes = issueCapabilityGrant(store, {
        grantor: maintainer.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 100, // 100ms
        actorRole: maintainer.role,
        now: "2026-01-01T00:00:00.000Z"
      });

      expect(issueRes.ok).toBe(true);
      if (!issueRes.ok) return;

      // Check after expiration instant
      const verifyRes = verifyCapabilityGrant(store, {
        id: issueRes.value.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        now: "2026-01-01T00:05:00.000Z"
      });

      expect(verifyRes.ok).toBe(false);
      if (!verifyRes.ok) {
        expect(verifyRes.code).toBe("capability_expired");
      }
    });

    it("rejects exhausted capability grants", () => {
      const store = createMemoryCapabilityStore();

      const issueRes = issueCapabilityGrant(store, {
        grantor: maintainer.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 60_000,
        maxUses: 1,
        actorRole: maintainer.role
      });
      if (!issueRes.ok) return;

      // Consume the single allowed use
      consumeCapabilityGrant(store, {
        id: issueRes.value.id,
        grantee: granteeUser,
        capability: sensitiveAction
      });

      // Attempt second consume
      const res = consumeCapabilityGrant(store, {
        id: issueRes.value.id,
        grantee: granteeUser,
        capability: sensitiveAction
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("capability_exhausted");
      }
    });

    it("immediately refuses revoked grants", () => {
      const store = createMemoryCapabilityStore();

      const issueRes = issueCapabilityGrant(store, {
        grantor: maintainer.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 60_000,
        actorRole: maintainer.role
      });
      if (!issueRes.ok) return;

      const revokeRes = revokeCapabilityGrant(store, {
        id: issueRes.value.id,
        actor: maintainer,
        reason: "Security rotation"
      });
      expect(revokeRes.ok).toBe(true);

      const check = verifyCapabilityGrant(store, {
        id: issueRes.value.id,
        grantee: granteeUser,
        capability: sensitiveAction
      });

      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("capability_revoked");
      }
    });
  });

  describe("retry & execution wrapper path", () => {
    it("preserves capability token when operation fails transiently then succeeds", async () => {
      const store = createMemoryCapabilityStore();

      const issueRes = issueCapabilityGrant(store, {
        grantor: maintainer.id,
        grantee: granteeUser,
        capability: sensitiveAction,
        ttlMs: 60_000,
        maxUses: 1,
        actorRole: maintainer.role
      });
      if (!issueRes.ok) return;

      let runs = 0;
      const result = await executeWithCapability(
        store,
        {
          id: issueRes.value.id,
          grantee: granteeUser,
          capability: sensitiveAction
        },
        async () => {
          runs++;
          if (runs === 1) {
            throw new Error("transient network blip");
          }
          return { executed: true, runCount: runs };
        },
        { maxRetries: 2, retryDelayMs: 5 }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.executed).toBe(true);
        expect(result.value.runCount).toBe(2);
      }

      // Check that the single use token was consumed exactly once upon success
      const grant = store.get(issueRes.value.id);
      expect(grant?.remainingUses).toBe(0);
    });
  });
});
