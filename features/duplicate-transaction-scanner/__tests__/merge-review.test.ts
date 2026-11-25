import { describe, expect, it } from "vitest";
import {
  applyReview,
  applyReviewAuthorized,
  createMergePlan,
  isTerminalState,
  rollbackReview,
  rollbackReviewAuthorized
} from "@/features/duplicate-transaction-scanner/lib/review";
import {
  PENDING_GROUP
} from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";
import type {
  CandidateGroup,
  ReviewInput
} from "@/features/duplicate-transaction-scanner/types";
import type { AuthContext } from "@/core/auth/middleware";

const ACTOR_ID = "session:test-actor";

function reviewInput(
  groupId: string,
  action: ReviewInput["action"],
  reason?: string
): ReviewInput {
  return { groupId, action, actorId: ACTOR_ID, reason };
}

describe("Deterministic Duplicate Detection and Merge Review (Issue #344)", () => {
  it("normal path: computes deterministic MergePlan selecting primary transaction by earliest ledger and timestamp", () => {
    const groupWithMultiple: CandidateGroup = {
      ...PENDING_GROUP,
      transactions: [
        {
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sourceAccount: "GAA...1",
          feeCharged: "100",
          memoType: "none",
          memo: "",
          createdAt: "2026-10-21T12:05:00.000Z",
          operationTypes: ["payment"],
          ledger: 1002,
          successful: true
        },
        {
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sourceAccount: "GAA...1",
          feeCharged: "100",
          memoType: "none",
          memo: "",
          createdAt: "2026-10-21T12:00:00.000Z",
          operationTypes: ["payment"],
          ledger: 1001,
          successful: true
        }
      ]
    };

    const plan = createMergePlan(groupWithMultiple);
    expect(plan.groupId).toBe(groupWithMultiple.id);
    // Primary must be the earliest ledger (1001), hash starting with aaaa...
    expect(plan.primaryTransaction.ledger).toBe(1001);
    expect(plan.primaryTransaction.hash).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(plan.duplicateTransactions).toHaveLength(1);
    expect(plan.duplicateTransactions[0].ledger).toBe(1002);

    expect(plan.matchingFields).toContain("sourceAccount");
    expect(plan.matchingFields).toContain("feeCharged");
    expect(plan.differingFields).toContain("ledger");
    expect(plan.differingFields).toContain("createdAt");
    expect(plan.confidenceScore).toBeGreaterThanOrEqual(0.85);
  });

  it("normal path: transitions pending → confirmed on confirm", () => {
    const result = applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("confirmed");
    expect(isTerminalState(result.value.state)).toBe(true);
  });

  it("failure path: rejects invalid transitions from terminal states", () => {
    const confirmed: CandidateGroup = { ...PENDING_GROUP, state: "confirmed" };
    const result = applyReview(confirmed, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_transition");
  });

  it("retry path: idempotent transitions and state preserves audit consistency", () => {
    const deferred: CandidateGroup = { ...PENDING_GROUP, state: "deferred" };
    const res1 = applyReview(deferred, reviewInput(PENDING_GROUP.id, "defer"));
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.value.state).toBe("deferred");

    const res2 = applyReview(res1.value, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.value.state).toBe("confirmed");
  });

  it("authorization path: allows maintainer role, rejects viewer role with permission_denied", () => {
    const viewerAuth: AuthContext = { role: "viewer", userId: "user-v" };
    const maintainerAuth: AuthContext = { role: "maintainer", userId: "admin-m" };

    const denied = applyReviewAuthorized(
      viewerAuth,
      PENDING_GROUP,
      reviewInput(PENDING_GROUP.id, "confirm")
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("permission_denied");

    const allowed = applyReviewAuthorized(
      maintainerAuth,
      PENDING_GROUP,
      reviewInput(PENDING_GROUP.id, "confirm")
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.state).toBe("confirmed");
  });

  it("rollback path: allows reverting confirmed duplicate decisions back to deferred", () => {
    const confirmed: CandidateGroup = { ...PENDING_GROUP, state: "confirmed" };

    const rolledBack = rollbackReview(confirmed, {
      actorId: "maintainer:ana",
      reason: "false_positive_reversal"
    });

    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.value.state).toBe("deferred");
    expect(rolledBack.value.reviewReason).toBe("false_positive_reversal");
  });

  it("rollback authorization path: enforces admin:recovery for merge decision rollback", () => {
    const confirmed: CandidateGroup = { ...PENDING_GROUP, state: "confirmed" };
    const viewerAuth: AuthContext = { role: "viewer" };
    const maintainerAuth: AuthContext = { role: "maintainer" };

    const denied = rollbackReviewAuthorized(viewerAuth, confirmed, { actorId: "v" });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("permission_denied");

    const allowed = rollbackReviewAuthorized(maintainerAuth, confirmed, { actorId: "m" });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.state).toBe("deferred");
  });
});

