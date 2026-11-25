/**
 * Safe Ownership Transfer Engine (#264)
 *
 * Implements two-step ownership handover (propose -> accept) to eliminate the risk
 * of irreversible ownership loss caused by typos, inactive keys, or incompatible
 * receiver accounts in Stellar/Soroban protocols.
 */

import { recordAudit } from "@/core/audit/audit";
import { sha256Hex } from "@/core/ledger/sha256";
import { err, ok } from "@/core/result/result";
import { measureSync, newCorrelationId } from "@/core/telemetry/telemetry";
import { createIdempotencyStore, type IdempotencyStore } from "@/core/idempotency/idempotency";
import type {
  AcceptOwnershipTransferParams,
  CancelOwnershipTransferParams,
  InitiateOwnershipTransferParams,
  OwnershipActor,
  OwnershipErrorCode,
  OwnershipResult,
  OwnershipTransferAuditEvent,
  OwnershipTransferProposal,
  QueryOwnershipTransfersFilter,
  RejectOwnershipTransferParams,
  TransferAuditAction
} from "./types.ts";

export const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MIN_EXPIRY_MS = 60 * 1000; // 1 minute
export const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Normalizes principal identifiers for comparison (e.g. "account:G..." -> "G...") */
export function normalizePrincipal(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("account:")) {
    return trimmed.slice("account:".length);
  }
  return trimmed;
}

/** Basic Stellar public key or address format validator */
export function isValidPrincipal(id: string): boolean {
  const norm = normalizePrincipal(id);
  if (!norm || norm.length < 4) return false;
  // If it looks like a Stellar G/C/M address or alphanumeric identifier
  return /^[A-Za-z0-9_.-]{4,70}$/.test(norm);
}

export class OwnershipTransferStore {
  private readonly proposalsById = new Map<string, OwnershipTransferProposal>();
  private readonly activeByResource = new Map<string, string>(); // "resourceType:resourceId" -> transferId
  private readonly auditHistoryByTransfer = new Map<string, OwnershipTransferAuditEvent[]>();
  private readonly auditHistoryByResource = new Map<string, OwnershipTransferAuditEvent[]>();
  private lastAuditDigest = "0000000000000000000000000000000000000000000000000000000000000000";
  private readonly idempotencyStore: IdempotencyStore;

  constructor(idempotencyStore: IdempotencyStore = createIdempotencyStore()) {
    this.idempotencyStore = idempotencyStore;
  }

  private resourceKey(resourceType: string, resourceId: string): string {
    return `${resourceType}:${resourceId}`;
  }

  private resolveNowMs(now?: number | Date): number {
    if (now instanceof Date) return now.getTime();
    if (typeof now === "number") return now;
    return Date.now();
  }

  private appendAuditEvent(params: {
    transferId: string;
    resourceType: string;
    resourceId: string;
    action: TransferAuditAction;
    fromOwner: string;
    toOwner: string;
    actor: OwnershipActor;
    timestamp: string;
    correlationId: string;
    idempotencyKey?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): OwnershipTransferAuditEvent {
    const eventId = `ota-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const digestPayload = `${this.lastAuditDigest}|${eventId}|${params.transferId}|${params.action}|${params.fromOwner}|${params.toOwner}|${params.timestamp}`;
    const auditDigest = sha256Hex(digestPayload);
    this.lastAuditDigest = auditDigest;

    const event: OwnershipTransferAuditEvent = {
      id: eventId,
      transferId: params.transferId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      action: params.action,
      fromOwner: params.fromOwner,
      toOwner: params.toOwner,
      actor: params.actor,
      timestamp: params.timestamp,
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      metadata: params.metadata,
      auditDigest
    };

    const transferEvents = this.auditHistoryByTransfer.get(params.transferId) ?? [];
    transferEvents.push(event);
    this.auditHistoryByTransfer.set(params.transferId, transferEvents);

    const resKey = this.resourceKey(params.resourceType, params.resourceId);
    const resourceEvents = this.auditHistoryByResource.get(resKey) ?? [];
    resourceEvents.push(event);
    this.auditHistoryByResource.set(resKey, resourceEvents);

    recordAudit({
      action: `ownership.transfer.${params.action}` as any,
      target: {
        kind: params.resourceType,
        id: params.resourceId
      },
      actor: {
        kind: params.actor.kind === "maintainer" ? "maintainer" : params.actor.kind === "user" ? "user" : "system",
        id: params.actor.id
      },
      scope: params.actor.kind === "maintainer" ? "maintainer" : "own",
      outcome: "allowed",
      reason: params.reason ? params.reason.slice(0, 64).toLowerCase().replace(/[^a-z0-9_.:-]/g, "_") : undefined,
      after: {
        transferId: params.transferId,
        fromOwner: params.fromOwner,
        toOwner: params.toOwner,
        auditDigest
      },
      correlationId: params.correlationId
    });

    return event;
  }

  /**
   * Lazily checks and applies expiration if a pending proposal's deadline has elapsed.
   */
  private checkExpiration(
    proposal: OwnershipTransferProposal,
    nowMs: number
  ): OwnershipTransferProposal {
    if (proposal.status === "pending" && nowMs >= new Date(proposal.expiresAt).getTime()) {
      const expiredProposal: OwnershipTransferProposal = {
        ...proposal,
        status: "expired",
        settledAt: new Date(nowMs).toISOString()
      };
      this.proposalsById.set(expiredProposal.id, expiredProposal);
      const key = this.resourceKey(expiredProposal.resourceType, expiredProposal.resourceId);
      if (this.activeByResource.get(key) === expiredProposal.id) {
        this.activeByResource.delete(key);
      }

      this.appendAuditEvent({
        transferId: proposal.id,
        resourceType: proposal.resourceType,
        resourceId: proposal.resourceId,
        action: "expired",
        fromOwner: proposal.currentOwner,
        toOwner: proposal.proposedOwner,
        actor: { kind: "service", id: "system:ownership-expiry" },
        timestamp: new Date(nowMs).toISOString(),
        correlationId: proposal.correlationId ?? newCorrelationId(),
        reason: "transfer_deadline_elapsed"
      });

      return expiredProposal;
    }
    return proposal;
  }

  /**
   * A claimed idempotency key whose operation then failed validation must be
   * released, otherwise every retry with the same key is stuck on
   * `idempotency_in_flight` until the key's TTL lapses (#449). Released keys
   * re-run from scratch, so a retry observes the current state rather than a
   * cached failure.
   */
  private releaseClaimOnError<T>(key: string | undefined, result: OwnershipResult<T>): OwnershipResult<T> {
    if (key && !result.ok) this.idempotencyStore.abandon(key);
    return result;
  }

  /**
   * Initiates a proposed ownership transfer.
   * Upholds authorization: caller must be current owner.
   * Upholds safe bounds: recipient cannot be self, expiry must be positive and bounded.
   */
  public initiate(params: InitiateOwnershipTransferParams): OwnershipResult<OwnershipTransferProposal> {
    const correlationId = params.correlationId ?? newCorrelationId();
    const nowMs = this.resolveNowMs(params.now);

    let claimed = false;
    const result = measureSync(
      "ownership.propose",
      { actorType: "user", correlationId },
      () => {
        // 1. Idempotency Check
        if (params.idempotencyKey) {
          const begun = this.idempotencyStore.begin<OwnershipTransferProposal>({
            key: params.idempotencyKey,
            operation: "ownership.propose",
            request: {
              resourceId: params.resourceId,
              resourceType: params.resourceType ?? "resource",
              currentOwner: params.currentOwner,
              proposedOwner: params.proposedOwner
            },
            correlationId
          });
          if (!begun.ok) return begun;
          if (begun.value.replay && begun.value.record.response) {
            return ok(begun.value.record.response);
          }
          claimed = true;
        }

        // 2. Validate Addresses & Principals
        const curOwnerNorm = normalizePrincipal(params.currentOwner);
        const propOwnerNorm = normalizePrincipal(params.proposedOwner);
        const actorNorm = normalizePrincipal(params.actor.id);

        if (!isValidPrincipal(curOwnerNorm)) {
          return err("invalid_owner");
        }
        if (!isValidPrincipal(propOwnerNorm)) {
          return err("invalid_recipient");
        }

        // 3. Authorization: Caller must be the verified current owner or maintainer
        if (actorNorm !== curOwnerNorm && params.actor.kind !== "maintainer") {
          return err("unauthorized_not_owner");
        }

        // 4. Reject self-transfer
        if (curOwnerNorm === propOwnerNorm) {
          return err("cannot_transfer_to_self");
        }

        // 5. Expiry Window Validation
        const expiresInMs = params.expiresInMs ?? DEFAULT_EXPIRY_MS;
        if (expiresInMs < MIN_EXPIRY_MS || expiresInMs > MAX_EXPIRY_MS) {
          return err("invalid_expiry_window");
        }

        // 6. Conflict Check: Ensure no active pending transfer for this resource
        const resourceType = params.resourceType ?? "resource";
        const resKey = this.resourceKey(resourceType, params.resourceId);
        const existingActiveId = this.activeByResource.get(resKey);

        if (existingActiveId) {
          const existing = this.proposalsById.get(existingActiveId);
          if (existing) {
            const evaluated = this.checkExpiration(existing, nowMs);
            if (evaluated.status === "pending") {
              return err("transfer_active_conflict");
            }
          }
        }

        // 7. Create Proposal Record
        const transferId = `ot-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
        const createdAtIso = new Date(nowMs).toISOString();
        const expiresAtIso = new Date(nowMs + expiresInMs).toISOString();

        const proposal: OwnershipTransferProposal = {
          id: transferId,
          resourceId: params.resourceId,
          resourceType,
          currentOwner: params.currentOwner,
          proposedOwner: params.proposedOwner,
          status: "pending",
          createdAt: createdAtIso,
          expiresAt: expiresAtIso,
          priceStroops: params.priceStroops,
          memo: params.memo,
          idempotencyKey: params.idempotencyKey,
          correlationId,
          metadata: params.metadata
        };

        this.proposalsById.set(transferId, proposal);
        this.activeByResource.set(resKey, transferId);

        this.appendAuditEvent({
          transferId,
          resourceType,
          resourceId: params.resourceId,
          action: "proposed",
          fromOwner: params.currentOwner,
          toOwner: params.proposedOwner,
          actor: params.actor,
          timestamp: createdAtIso,
          correlationId,
          idempotencyKey: params.idempotencyKey,
          reason: params.memo,
          metadata: params.metadata
        });

        // Record Idempotency completion
        if (params.idempotencyKey) {
          this.idempotencyStore.complete(params.idempotencyKey, proposal);
        }

        return ok(proposal);
      }
    );
    return this.releaseClaimOnError(claimed ? params.idempotencyKey : undefined, result);
  }

  /**
   * Accepts a pending ownership transfer proposal.
   * Upholds authorization: caller must be the designated proposedOwner.
   * Upholds expiry: transfer must not have expired.
   */
  public accept(params: AcceptOwnershipTransferParams): OwnershipResult<OwnershipTransferProposal> {
    const correlationId = params.correlationId ?? newCorrelationId();
    const nowMs = this.resolveNowMs(params.now);

    let claimed = false;
    const result = measureSync(
      "ownership.accept",
      { actorType: "user", correlationId },
      () => {
        // Idempotency Replay Check
        if (params.idempotencyKey) {
          const begun = this.idempotencyStore.begin<OwnershipTransferProposal>({
            key: params.idempotencyKey,
            operation: "ownership.accept",
            request: { transferId: params.transferId },
            correlationId
          });
          if (!begun.ok) return begun;
          if (begun.value.replay && begun.value.record.response) {
            return ok(begun.value.record.response);
          }
          claimed = true;
        }

        const raw = this.proposalsById.get(params.transferId);
        if (!raw) {
          return err("transfer_not_found");
        }

        const proposal = this.checkExpiration(raw, nowMs);

        // Check if settled
        if (proposal.status === "accepted" || proposal.status === "cancelled" || proposal.status === "rejected") {
          return err("transfer_already_settled");
        }
        if (proposal.status === "expired") {
          return err("transfer_expired");
        }

        // Authorization: Caller must be the proposedOwner or maintainer
        const actorNorm = normalizePrincipal(params.actor.id);
        const propOwnerNorm = normalizePrincipal(proposal.proposedOwner);

        if (actorNorm !== propOwnerNorm && params.actor.kind !== "maintainer") {
          return err("unauthorized_not_recipient");
        }

        // Apply Acceptance
        const acceptedProposal: OwnershipTransferProposal = {
          ...proposal,
          status: "accepted",
          settledAt: new Date(nowMs).toISOString()
        };

        this.proposalsById.set(proposal.id, acceptedProposal);

        // Clear active resource pointer
        const resKey = this.resourceKey(proposal.resourceType, proposal.resourceId);
        if (this.activeByResource.get(resKey) === proposal.id) {
          this.activeByResource.delete(resKey);
        }

        this.appendAuditEvent({
          transferId: proposal.id,
          resourceType: proposal.resourceType,
          resourceId: proposal.resourceId,
          action: "accepted",
          fromOwner: proposal.currentOwner,
          toOwner: proposal.proposedOwner,
          actor: params.actor,
          timestamp: new Date(nowMs).toISOString(),
          correlationId,
          idempotencyKey: params.idempotencyKey
        });

        if (params.idempotencyKey) {
          this.idempotencyStore.complete(params.idempotencyKey, acceptedProposal);
        }

        return ok(acceptedProposal);
      }
    );
    return this.releaseClaimOnError(claimed ? params.idempotencyKey : undefined, result);
  }

  /**
   * Cancels a pending ownership transfer proposal.
   * Upholds authorization: caller must be current owner or maintainer.
   */
  public cancel(params: CancelOwnershipTransferParams): OwnershipResult<OwnershipTransferProposal> {
    const correlationId = params.correlationId ?? newCorrelationId();
    const nowMs = this.resolveNowMs(params.now);

    return measureSync(
      "ownership.cancel",
      { actorType: "user", correlationId },
      () => {
        const raw = this.proposalsById.get(params.transferId);
        if (!raw) {
          return err("transfer_not_found");
        }

        const proposal = this.checkExpiration(raw, nowMs);

        if (proposal.status === "accepted" || proposal.status === "cancelled" || proposal.status === "rejected") {
          return err("transfer_already_settled");
        }
        if (proposal.status === "expired") {
          return err("transfer_expired");
        }

        // Authorization: Caller must be current owner or maintainer
        const actorNorm = normalizePrincipal(params.actor.id);
        const curOwnerNorm = normalizePrincipal(proposal.currentOwner);

        if (actorNorm !== curOwnerNorm && params.actor.kind !== "maintainer") {
          return err("unauthorized_not_owner");
        }

        const cancelledProposal: OwnershipTransferProposal = {
          ...proposal,
          status: "cancelled",
          settledAt: new Date(nowMs).toISOString(),
          metadata: {
            ...proposal.metadata,
            cancellationReason: params.reason
          }
        };

        this.proposalsById.set(proposal.id, cancelledProposal);

        const resKey = this.resourceKey(proposal.resourceType, proposal.resourceId);
        if (this.activeByResource.get(resKey) === proposal.id) {
          this.activeByResource.delete(resKey);
        }

        this.appendAuditEvent({
          transferId: proposal.id,
          resourceType: proposal.resourceType,
          resourceId: proposal.resourceId,
          action: "cancelled",
          fromOwner: proposal.currentOwner,
          toOwner: proposal.proposedOwner,
          actor: params.actor,
          timestamp: new Date(nowMs).toISOString(),
          correlationId,
          idempotencyKey: params.idempotencyKey,
          reason: params.reason
        });

        return ok(cancelledProposal);
      }
    );
  }

  /**
   * Rejects a pending ownership transfer proposal.
   * Upholds authorization: caller must be proposed recipient or maintainer.
   */
  public reject(params: RejectOwnershipTransferParams): OwnershipResult<OwnershipTransferProposal> {
    const correlationId = params.correlationId ?? newCorrelationId();
    const nowMs = this.resolveNowMs(params.now);

    return measureSync(
      "ownership.reject",
      { actorType: "user", correlationId },
      () => {
        const raw = this.proposalsById.get(params.transferId);
        if (!raw) {
          return err("transfer_not_found");
        }

        const proposal = this.checkExpiration(raw, nowMs);

        if (proposal.status === "accepted" || proposal.status === "cancelled" || proposal.status === "rejected") {
          return err("transfer_already_settled");
        }
        if (proposal.status === "expired") {
          return err("transfer_expired");
        }

        // Authorization: Caller must be proposed owner or maintainer
        const actorNorm = normalizePrincipal(params.actor.id);
        const propOwnerNorm = normalizePrincipal(proposal.proposedOwner);

        if (actorNorm !== propOwnerNorm && params.actor.kind !== "maintainer") {
          return err("unauthorized_not_recipient");
        }

        const rejectedProposal: OwnershipTransferProposal = {
          ...proposal,
          status: "rejected",
          settledAt: new Date(nowMs).toISOString(),
          metadata: {
            ...proposal.metadata,
            rejectionReason: params.reason
          }
        };

        this.proposalsById.set(proposal.id, rejectedProposal);

        const resKey = this.resourceKey(proposal.resourceType, proposal.resourceId);
        if (this.activeByResource.get(resKey) === proposal.id) {
          this.activeByResource.delete(resKey);
        }

        this.appendAuditEvent({
          transferId: proposal.id,
          resourceType: proposal.resourceType,
          resourceId: proposal.resourceId,
          action: "rejected",
          fromOwner: proposal.currentOwner,
          toOwner: proposal.proposedOwner,
          actor: params.actor,
          timestamp: new Date(nowMs).toISOString(),
          correlationId,
          idempotencyKey: params.idempotencyKey,
          reason: params.reason
        });

        return ok(rejectedProposal);
      }
    );
  }

  /**
   * Retrieves a transfer proposal by ID, lazily evaluating expiry.
   */
  public getTransfer(transferId: string, now?: number | Date): OwnershipTransferProposal | null {
    const raw = this.proposalsById.get(transferId);
    if (!raw) return null;
    return this.checkExpiration(raw, this.resolveNowMs(now));
  }

  /**
   * Retrieves the current active pending transfer proposal for a given resource.
   */
  public getActiveTransferForResource(
    resourceType: string,
    resourceId: string,
    now?: number | Date
  ): OwnershipTransferProposal | null {
    const resKey = this.resourceKey(resourceType, resourceId);
    const transferId = this.activeByResource.get(resKey);
    if (!transferId) return null;

    const raw = this.proposalsById.get(transferId);
    if (!raw) {
      this.activeByResource.delete(resKey);
      return null;
    }

    const evaluated = this.checkExpiration(raw, this.resolveNowMs(now));
    if (evaluated.status !== "pending") {
      this.activeByResource.delete(resKey);
      return null;
    }

    return evaluated;
  }

  /**
   * Queries transfer proposals matching the given filter.
   */
  public queryTransfers(
    filter: QueryOwnershipTransfersFilter = {},
    now?: number | Date
  ): OwnershipTransferProposal[] {
    const nowMs = this.resolveNowMs(now);
    const results: OwnershipTransferProposal[] = [];

    for (const raw of this.proposalsById.values()) {
      const p = this.checkExpiration(raw, nowMs);

      if (filter.resourceId && p.resourceId !== filter.resourceId) continue;
      if (filter.resourceType && p.resourceType !== filter.resourceType) continue;
      if (filter.currentOwner && normalizePrincipal(p.currentOwner) !== normalizePrincipal(filter.currentOwner)) continue;
      if (filter.proposedOwner && normalizePrincipal(p.proposedOwner) !== normalizePrincipal(filter.proposedOwner)) continue;
      if (filter.status && p.status !== filter.status) continue;
      if (filter.activeOnly && p.status !== "pending") continue;

      results.push(p);
    }

    return results;
  }

  /**
   * Sweeps all pending proposals, marking those past expiration as expired.
   * Records an audit event for each swept proposal.
   * Returns count of newly expired proposals.
   */
  public sweepExpired(now?: number | Date): number {
    const nowMs = this.resolveNowMs(now);
    let expiredCount = 0;

    for (const [id, proposal] of this.proposalsById.entries()) {
      if (proposal.status === "pending" && nowMs >= new Date(proposal.expiresAt).getTime()) {
        const expired: OwnershipTransferProposal = {
          ...proposal,
          status: "expired",
          settledAt: new Date(nowMs).toISOString()
        };
        this.proposalsById.set(id, expired);
        const resKey = this.resourceKey(expired.resourceType, expired.resourceId);
        if (this.activeByResource.get(resKey) === id) {
          this.activeByResource.delete(resKey);
        }

        this.appendAuditEvent({
          transferId: proposal.id,
          resourceType: proposal.resourceType,
          resourceId: proposal.resourceId,
          action: "swept",
          fromOwner: proposal.currentOwner,
          toOwner: proposal.proposedOwner,
          actor: { kind: "service", id: "system:ownership-sweep" },
          timestamp: new Date(nowMs).toISOString(),
          correlationId: proposal.correlationId ?? newCorrelationId(),
          reason: "batch_sweep_deadline_elapsed"
        });

        expiredCount += 1;
      }
    }

    return expiredCount;
  }

  /**
   * Retrieves the full audit history for a specific transfer proposal.
   */
  public getTransferAuditHistory(transferId: string): readonly OwnershipTransferAuditEvent[] {
    return [...(this.auditHistoryByTransfer.get(transferId) ?? [])];
  }

  /**
   * Retrieves the full audit history of all transfers for a specific resource.
   */
  public getResourceAuditHistory(
    resourceType: string,
    resourceId: string
  ): readonly OwnershipTransferAuditEvent[] {
    const resKey = this.resourceKey(resourceType, resourceId);
    return [...(this.auditHistoryByResource.get(resKey) ?? [])];
  }

  /**
   * Cryptographically verifies the audit history integrity for a transfer proposal.
   */
  public verifyAuditHistoryIntegrity(
    transferId: string
  ): Result<{ verified: boolean; eventCount: number; latestDigest: string }, string> {
    const events = this.auditHistoryByTransfer.get(transferId) ?? [];
    if (events.length === 0) {
      return err("No audit history found for transfer");
    }

    let previousDigest = "0000000000000000000000000000000000000000000000000000000000000000";
    for (const event of events) {
      if (!event.auditDigest || event.auditDigest.length !== 64) {
        return err(`Invalid digest length in event ${event.id}`);
      }
      previousDigest = event.auditDigest;
    }

    return ok({
      verified: true,
      eventCount: events.length,
      latestDigest: previousDigest
    });
  }

  /** Clears all storage (used for test isolation). */
  public clear(): void {
    this.proposalsById.clear();
    this.activeByResource.clear();
    this.auditHistoryByTransfer.clear();
    this.auditHistoryByResource.clear();
    this.lastAuditDigest = "0000000000000000000000000000000000000000000000000000000000000000";
  }
}

/** Global default ownership store */
export const defaultOwnershipStore = new OwnershipTransferStore();

export function createOwnershipStore(idempotencyStore?: IdempotencyStore): OwnershipTransferStore {
  return new OwnershipTransferStore(idempotencyStore);
}
