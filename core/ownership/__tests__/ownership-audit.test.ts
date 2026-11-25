import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createOwnershipStore, OwnershipTransferStore } from "../ownership";
import { getAuditTrail } from "@/core/audit/audit";
import type { OwnershipActor } from "../types";

describe("Ownership Transfer with Expiry and Audit History (Issue #367)", () => {
  let store: OwnershipTransferStore;
  const ownerKey = Keypair.random();
  const recipientKey = Keypair.random();
  const thirdPartyKey = Keypair.random();

  const OWNER_A = ownerKey.publicKey();
  const RECIPIENT_B = recipientKey.publicKey();
  const ACTOR_C = thirdPartyKey.publicKey();

  const ownerActor: OwnershipActor = { kind: "user", id: OWNER_A };
  const recipientActor: OwnershipActor = { kind: "user", id: RECIPIENT_B };
  const maintainerActor: OwnershipActor = { kind: "maintainer", id: "maintainer:ops-lead" };

  beforeEach(() => {
    store = createOwnershipStore();
    getAuditTrail().reset();
  });

  describe("Normal Path: Proposal, Acceptance, and Audit Trail", () => {
    it("records audit history when proposal is initiated and accepted", () => {
      const baseNow = 1_700_000_000_000;
      const initRes = store.initiate({
        resourceId: "account-config-01",
        resourceType: "account_control",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        expiresInMs: 3600_000,
        memo: "Handover to team lead",
        actor: ownerActor,
        now: baseNow
      });

      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      const proposal = initRes.value;

      // Check transfer audit history
      const transferHistory = store.getTransferAuditHistory(proposal.id);
      expect(transferHistory.length).toBe(1);
      expect(transferHistory[0].action).toBe("proposed");
      expect(transferHistory[0].fromOwner).toBe(OWNER_A);
      expect(transferHistory[0].toOwner).toBe(RECIPIENT_B);
      expect(transferHistory[0].actor.id).toBe(OWNER_A);
      expect(transferHistory[0].reason).toBe("Handover to team lead");
      expect(transferHistory[0].auditDigest).toBeDefined();

      // Check resource audit history
      const resHistory = store.getResourceAuditHistory("account_control", "account-config-01");
      expect(resHistory.length).toBe(1);
      expect(resHistory[0].id).toBe(transferHistory[0].id);

      // Now accept the proposal
      const acceptRes = store.accept({
        transferId: proposal.id,
        actor: recipientActor,
        now: baseNow + 60_000
      });

      expect(acceptRes.ok).toBe(true);
      const updatedHistory = store.getTransferAuditHistory(proposal.id);
      expect(updatedHistory.length).toBe(2);
      expect(updatedHistory[1].action).toBe("accepted");
      expect(updatedHistory[1].actor.id).toBe(RECIPIENT_B);
      expect(updatedHistory[1].auditDigest).not.toBe(updatedHistory[0].auditDigest);

      // Cryptographic integrity check
      const integrity = store.verifyAuditHistoryIntegrity(proposal.id);
      expect(integrity.ok).toBe(true);
      if (integrity.ok) {
        expect(integrity.value.verified).toBe(true);
        expect(integrity.value.eventCount).toBe(2);
      }

      // Check global audit trail
      const auditTrail = getAuditTrail().all();
      expect(auditTrail.some(a => a.action === "ownership.transfer.proposed")).toBe(true);
      expect(auditTrail.some(a => a.action === "ownership.transfer.accepted")).toBe(true);
    });
  });

  describe("Failure and Cancellation Paths", () => {
    it("records audit history when proposal is cancelled by owner", () => {
      const baseNow = 1_700_000_000_000;
      const initRes = store.initiate({
        resourceId: "key-role-02",
        resourceType: "role",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        actor: ownerActor,
        now: baseNow
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const cancelRes = store.cancel({
        transferId: initRes.value.id,
        actor: ownerActor,
        reason: "Cancelled due to policy change",
        now: baseNow + 10_000
      });
      expect(cancelRes.ok).toBe(true);

      const history = store.getTransferAuditHistory(initRes.value.id);
      expect(history.length).toBe(2);
      expect(history[1].action).toBe("cancelled");
      expect(history[1].reason).toBe("Cancelled due to policy change");

      const auditTrail = getAuditTrail().all();
      expect(auditTrail.some(a => a.action === "ownership.transfer.cancelled")).toBe(true);
    });

    it("records audit history when proposal is rejected by recipient", () => {
      const baseNow = 1_700_000_000_000;
      const initRes = store.initiate({
        resourceId: "treasury-03",
        resourceType: "treasury",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        actor: ownerActor,
        now: baseNow
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const rejectRes = store.reject({
        transferId: initRes.value.id,
        actor: recipientActor,
        reason: "Wrong recipient address designated",
        now: baseNow + 20_000
      });
      expect(rejectRes.ok).toBe(true);

      const history = store.getTransferAuditHistory(initRes.value.id);
      expect(history.length).toBe(2);
      expect(history[1].action).toBe("rejected");
      expect(history[1].reason).toBe("Wrong recipient address designated");
    });
  });

  describe("Expiry and Sweep Paths", () => {
    it("records audit history on lazy expiration check", () => {
      const baseNow = 1_700_000_000_000;
      const initRes = store.initiate({
        resourceId: "vault-04",
        resourceType: "vault",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        expiresInMs: 60_000,
        actor: ownerActor,
        now: baseNow
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      // Access after expiration
      const retrieved = store.getTransfer(initRes.value.id, baseNow + 120_000);
      expect(retrieved?.status).toBe("expired");

      const history = store.getTransferAuditHistory(initRes.value.id);
      expect(history.length).toBe(2);
      expect(history[1].action).toBe("expired");
      expect(history[1].reason).toBe("transfer_deadline_elapsed");
    });

    it("records audit history during batch sweep of expired proposals", () => {
      const baseNow = 1_700_000_000_000;
      const p1 = store.initiate({
        resourceId: "doc-01",
        resourceType: "document",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        expiresInMs: 60_000,
        actor: ownerActor,
        now: baseNow
      });
      const p2 = store.initiate({
        resourceId: "doc-02",
        resourceType: "document",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        expiresInMs: 60_000,
        actor: ownerActor,
        now: baseNow
      });
      expect(p1.ok && p2.ok).toBe(true);
      if (!p1.ok || !p2.ok) return;

      const sweptCount = store.sweepExpired(baseNow + 90_000);
      expect(sweptCount).toBe(2);

      const hist1 = store.getTransferAuditHistory(p1.value.id);
      expect(hist1.some(h => h.action === "swept")).toBe(true);

      const hist2 = store.getTransferAuditHistory(p2.value.id);
      expect(hist2.some(h => h.action === "swept")).toBe(true);
    });
  });

  describe("Authorization and Maintainer Scenarios", () => {
    it("allows maintainer to initiate with maintainer audit scope", () => {
      const baseNow = 1_700_000_000_000;
      const initRes = store.initiate({
        resourceId: "emergency-escrow",
        resourceType: "escrow",
        currentOwner: OWNER_A,
        proposedOwner: RECIPIENT_B,
        actor: maintainerActor,
        now: baseNow
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const history = store.getTransferAuditHistory(initRes.value.id);
      expect(history[0].actor.kind).toBe("maintainer");

      const auditTrail = getAuditTrail().all();
      const auditEntry = auditTrail.find(a => a.after?.transferId === initRes.value.id);
      expect(auditEntry?.scope).toBe("maintainer");
    });
  });
});
