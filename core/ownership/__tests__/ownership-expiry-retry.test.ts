import { beforeEach, describe, expect, it } from "vitest";
import { OwnershipTransferStore } from "../ownership";
import { createIdempotencyStore } from "@/core/idempotency/idempotency";
import type { OwnershipActor } from "../types";

/**
 * #449 gap coverage: retries that hit a failure path must surface the real
 * outcome instead of being stuck behind an un-released idempotency claim.
 */
describe("Issue #449: ownership acceptance/expiry under retry", () => {
  let store: OwnershipTransferStore;
  const NOW = 1_700_000_000_000;
  const owner: OwnershipActor = { kind: "user", id: "account:GALICE1234567890" };
  const recipient: OwnershipActor = { kind: "user", id: "account:GBOB1234567890" };
  const stranger: OwnershipActor = { kind: "user", id: "account:GEVE1234567890" };

  const propose = (resourceId: string, extra: Partial<Parameters<OwnershipTransferStore["initiate"]>[0]> = {}) =>
    store.initiate({
      resourceId,
      currentOwner: owner.id,
      proposedOwner: recipient.id,
      actor: owner,
      expiresInMs: 60_000,
      now: NOW,
      ...extra
    });

  beforeEach(() => {
    store = new OwnershipTransferStore(createIdempotencyStore());
  });

  it("retrying an expired accept with the same key keeps reporting transfer_expired", () => {
    const init = propose("r-expired");
    if (!init.ok) throw new Error("setup");

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = store.accept({
        transferId: init.value.id,
        actor: recipient,
        idempotencyKey: "accept-expired",
        now: NOW + 61_000
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("transfer_expired");
    }
  });

  it("an unauthorized accept does not poison the key for the rightful recipient", () => {
    const init = propose("r-auth");
    if (!init.ok) throw new Error("setup");

    const denied = store.accept({ transferId: init.value.id, actor: stranger, idempotencyKey: "shared-key", now: NOW });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unauthorized_not_recipient");

    const accepted = store.accept({ transferId: init.value.id, actor: recipient, idempotencyKey: "shared-key", now: NOW });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.status).toBe("accepted");
  });

  it("a proposal retried after its conflict clears succeeds exactly once", () => {
    const first = propose("r-conflict");
    if (!first.ok) throw new Error("setup");

    const blocked = propose("r-conflict", { proposedOwner: stranger.id, idempotencyKey: "retry-propose" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("transfer_active_conflict");

    // Recovery: the blocking proposal expires and is swept.
    expect(store.sweepExpired(NOW + 61_000)).toBe(1);

    const retried = propose("r-conflict", { proposedOwner: stranger.id, idempotencyKey: "retry-propose", now: NOW + 61_000 });
    expect(retried.ok).toBe(true);
    const replay = propose("r-conflict", { proposedOwner: stranger.id, idempotencyKey: "retry-propose", now: NOW + 61_000 });
    expect(replay.ok && retried.ok && replay.value.id === retried.value.id).toBe(true);
  });

  it("accepting at the exact expiry instant is rejected (deadline is exclusive)", () => {
    const init = propose("r-boundary");
    if (!init.ok) throw new Error("setup");

    const atDeadline = store.accept({ transferId: init.value.id, actor: recipient, now: NOW + 60_000 });
    expect(atDeadline.ok).toBe(false);
    if (!atDeadline.ok) expect(atDeadline.code).toBe("transfer_expired");
  });

  it("a successful accept replays from the key even after the proposal would have expired", () => {
    const init = propose("r-replay");
    if (!init.ok) throw new Error("setup");

    const first = store.accept({ transferId: init.value.id, actor: recipient, idempotencyKey: "accept-ok", now: NOW + 1 });
    const replay = store.accept({ transferId: init.value.id, actor: recipient, idempotencyKey: "accept-ok", now: NOW + 120_000 });
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value.settledAt).toBe(first.value.settledAt);
    expect(store.getTransferAuditHistory(init.value.id)).toHaveLength(2);
  });
});
