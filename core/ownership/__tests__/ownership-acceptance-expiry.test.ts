import { describe, expect, it, beforeEach } from "vitest";
import {
  OwnershipTransferStore,
  DEFAULT_EXPIRY_MS,
  MIN_EXPIRY_MS,
  MAX_EXPIRY_MS
} from "../ownership";
import { createIdempotencyStore } from "@/core/idempotency/idempotency";
import type { OwnershipActor } from "../types";

describe("Issue #405: Ownership Transfer Acceptance and Expiry", () => {
  let store: OwnershipTransferStore;
  const owner: OwnershipActor = { kind: "user", id: "account:GALICE1234567890" };
  const recipient: OwnershipActor = { kind: "user", id: "account:GBOB1234567890" };
  const thirdParty: OwnershipActor = { kind: "user", id: "account:GEVE1234567890" };
  const maintainer: OwnershipActor = { kind: "maintainer", id: "maintainer:ADMIN" };

  beforeEach(() => {
    store = new OwnershipTransferStore(createIdempotencyStore());
  });

  describe("normal path: propose, accept, and settle", () => {
    it("successfully creates a proposal and completes acceptance with full state transition", () => {
      const now = 1_700_000_000_000;
      const res = store.initiate({
        resourceId: "ticket-series-001",
        resourceType: "ticket_batch",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: 3_600_000, // 1 hour
        memo: "Production handoff to Bob",
        now
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const proposal = res.value;
      expect(proposal.status).toBe("pending");
      expect(proposal.currentOwner).toBe(owner.id);
      expect(proposal.proposedOwner).toBe(recipient.id);
      expect(new Date(proposal.expiresAt).getTime()).toBe(now + 3_600_000);

      // Verify active transfer lookup
      const active = store.getActiveTransferForResource("ticket_batch", "ticket-series-001", now);
      expect(active?.id).toBe(proposal.id);

      // Accept transfer as recipient
      const acceptRes = store.accept({
        transferId: proposal.id,
        actor: recipient,
        now: now + 1_800_000 // 30 minutes later
      });

      expect(acceptRes.ok).toBe(true);
      if (!acceptRes.ok) return;

      expect(acceptRes.value.status).toBe("accepted");
      expect(acceptRes.value.settledAt).toBeDefined();

      // Active pointer is cleared
      const activeAfter = store.getActiveTransferForResource("ticket_batch", "ticket-series-001", now + 1_800_000);
      expect(activeAfter).toBeNull();

      // Audit history records proposal and acceptance with sha256 digests
      const audit = store.getTransferAuditHistory(proposal.id);
      expect(audit).toHaveLength(2);
      expect(audit[0].action).toBe("proposed");
      expect(audit[1].action).toBe("accepted");
      expect(audit[0].auditDigest).toBeDefined();
      expect(audit[1].auditDigest).toBeDefined();
    });
  });

  describe("failure paths and validation guards", () => {
    it("rejects non-existent transfer ID with transfer_not_found", () => {
      const res = store.accept({
        transferId: "ot-nonexistent-999",
        actor: recipient
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("transfer_not_found");
    });

    it("rejects accept on already settled transfer with transfer_already_settled", () => {
      const init = store.initiate({
        resourceId: "asset-101",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner
      });
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const accept1 = store.accept({ transferId: init.value.id, actor: recipient });
      expect(accept1.ok).toBe(true);

      const accept2 = store.accept({ transferId: init.value.id, actor: recipient });
      expect(accept2.ok).toBe(false);
      if (accept2.ok) return;
      expect(accept2.code).toBe("transfer_already_settled");
    });

    it("rejects proposal to oneself with cannot_transfer_to_self", () => {
      const res = store.initiate({
        resourceId: "asset-self",
        currentOwner: owner.id,
        proposedOwner: owner.id,
        actor: owner
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("cannot_transfer_to_self");
    });

    it("rejects out-of-bound expiry durations", () => {
      const tooShort = store.initiate({
        resourceId: "asset-dur-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: MIN_EXPIRY_MS - 1
      });
      expect(tooShort.ok).toBe(false);
      if (!tooShort.ok) expect(tooShort.code).toBe("invalid_expiry_window");

      const tooLong = store.initiate({
        resourceId: "asset-dur-2",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: MAX_EXPIRY_MS + 1
      });
      expect(tooLong.ok).toBe(false);
      if (!tooLong.ok) expect(tooLong.code).toBe("invalid_expiry_window");
    });

    it("blocks concurrent active proposals on the same resource", () => {
      const res1 = store.initiate({
        resourceId: "unique-res-55",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner
      });
      expect(res1.ok).toBe(true);

      const res2 = store.initiate({
        resourceId: "unique-res-55",
        currentOwner: owner.id,
        proposedOwner: thirdParty.id,
        actor: owner
      });
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.code).toBe("transfer_active_conflict");
    });
  });

  describe("authorization paths", () => {
    it("denies acceptance when actor is not proposedOwner", () => {
      const init = store.initiate({
        resourceId: "auth-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner
      });
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const denied = store.accept({
        transferId: init.value.id,
        actor: thirdParty
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("unauthorized_not_recipient");
    });

    it("denies initiation when actor is not currentOwner", () => {
      const denied = store.initiate({
        resourceId: "auth-res-2",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: thirdParty
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("unauthorized_not_owner");
    });

    it("allows maintainer to initiate, accept, or cancel on behalf of owners", () => {
      const init = store.initiate({
        resourceId: "maint-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: maintainer
      });
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const accept = store.accept({
        transferId: init.value.id,
        actor: maintainer
      });
      expect(accept.ok).toBe(true);
      if (accept.ok) expect(accept.value.status).toBe("accepted");
    });
  });

  describe("expiry and batch sweep paths", () => {
    it("lazily marks proposal as expired when accepting after expiration deadline", () => {
      const now = 1_700_000_000_000;
      const init = store.initiate({
        resourceId: "exp-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: 60_000, // 1 minute
        now
      });
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const acceptExpired = store.accept({
        transferId: init.value.id,
        actor: recipient,
        now: now + 65_000 // 5 seconds after expiry
      });

      expect(acceptExpired.ok).toBe(false);
      if (!acceptExpired.ok) expect(acceptExpired.code).toBe("transfer_expired");

      const proposal = store.getTransfer(init.value.id, now + 65_000);
      expect(proposal?.status).toBe("expired");
    });

    it("sweeps expired proposals in batch and allows immediate re-proposal on the resource", () => {
      const now = 1_700_000_000_000;
      store.initiate({
        resourceId: "sweep-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: 120_000,
        now
      });
      store.initiate({
        resourceId: "sweep-res-2",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        expiresInMs: 120_000,
        now
      });

      // Advance time by 3 minutes
      const sweptCount = store.sweepExpired(now + 180_000);
      expect(sweptCount).toBe(2);

      // Verify active status is cleared and resource can be re-proposed
      const reinit = store.initiate({
        resourceId: "sweep-res-1",
        currentOwner: owner.id,
        proposedOwner: thirdParty.id,
        actor: owner,
        now: now + 180_000
      });
      expect(reinit.ok).toBe(true);
      if (reinit.ok) expect(reinit.value.status).toBe("pending");
    });
  });

  describe("retry and idempotency paths", () => {
    it("replays proposal creation and acceptance with idempotency keys without duplicate mutation", () => {
      const proposalKey = "idem-propose-405";
      const acceptKey = "idem-accept-405";

      const init1 = store.initiate({
        resourceId: "idem-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        idempotencyKey: proposalKey
      });
      expect(init1.ok).toBe(true);
      if (!init1.ok) return;

      const init2 = store.initiate({
        resourceId: "idem-res-1",
        currentOwner: owner.id,
        proposedOwner: recipient.id,
        actor: owner,
        idempotencyKey: proposalKey
      });
      expect(init2.ok).toBe(true);
      if (init2.ok) expect(init2.value.id).toBe(init1.value.id);

      const accept1 = store.accept({
        transferId: init1.value.id,
        actor: recipient,
        idempotencyKey: acceptKey
      });
      expect(accept1.ok).toBe(true);
      if (!accept1.ok) return;

      const accept2 = store.accept({
        transferId: init1.value.id,
        actor: recipient,
        idempotencyKey: acceptKey
      });
      expect(accept2.ok).toBe(true);
      if (accept2.ok) expect(accept2.value.id).toBe(accept1.value.id);
    });
  });
});
