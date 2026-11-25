import { err, ok, type Result } from "@/core/result/result";
import {
  recordAudit,
  type AuditActor,
  type AuditEvent,
  type AuditInput
} from "@/core/audit/audit";
import { settlementDisputeMachine } from "@/core/lifecycle/records";
import type {
  AddEvidenceInput,
  AddNoteInput,
  DisputeActionInput,
  DisputeEvidence,
  DisputeNote,
  OpenSettlementDisputeInput,
  SettlementDispute,
  SettlementDisputeErrorCode,
  SettlementDisputeStoreOptions,
  SettlementDisputeStatus
} from "./types";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Audit-action literals used by the domain boundary contract verifier. */
export const SETTLEMENT_DISPUTE_AUDIT_ACTION_MARKERS = {
  opened: { action: "settlement_dispute.opened" },
  investigating: { action: "settlement_dispute.investigating" },
  evidence: { action: "settlement_dispute.evidence_added" },
  note: { action: "settlement_dispute.note_added" },
  resolved: { action: "settlement_dispute.resolved" },
  rejected: { action: "settlement_dispute.rejected" },
  reopened: { action: "settlement_dispute.reopened" }
} as const;

function isMaintainer(actor: AuditActor): boolean {
  return actor.kind === "maintainer";
}

export interface SettlementDisputeStore {
  readonly open: (input: OpenSettlementDisputeInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly investigate: (input: DisputeActionInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly resolve: (input: DisputeActionInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly reject: (input: DisputeActionInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly reopen: (input: DisputeActionInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly addEvidence: (input: AddEvidenceInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly addNote: (input: AddNoteInput) => Result<SettlementDispute, SettlementDisputeErrorCode>;
  readonly get: (id: string, viewer?: AuditActor) => SettlementDispute | undefined;
  readonly list: (viewer?: AuditActor) => readonly SettlementDispute[];
  readonly auditEvents: () => readonly AuditEvent[];
}

export function createSettlementDisputeStore(
  options: SettlementDisputeStoreOptions = {}
): SettlementDisputeStore {
  const now = options.now ?? (() => Date.now());
  const record = options.record ?? recordAudit;
  const maxReopens = options.maxReopens ?? 1;
  const maxEvidence = options.maxEvidence ?? 25;
  let sequence = 0;
  const newId = options.newId ?? (() => `dispute-${++sequence}`);
  const disputes = new Map<string, SettlementDispute>();
  const auditEvents: AuditEvent[] = [];

  const iso = (ms: number): string => new Date(ms).toISOString();

  function audit(input: AuditInput): AuditEvent | undefined {
    const event = record(input);
    if (event) auditEvents.push(event);
    return event;
  }

  function actionReason(input: { readonly reason?: string }, fallback: string): string {
    return input.reason && REASON_PATTERN.test(input.reason) ? input.reason : fallback;
  }

  function canViewPrivate(dispute: SettlementDispute, viewer?: AuditActor): boolean {
    if (!viewer) return false;
    if (isMaintainer(viewer)) return true;
    return viewer.kind === "user" && (viewer.id === dispute.claimantId || viewer.id === dispute.respondentId);
  }

  function visible(dispute: SettlementDispute, viewer?: AuditActor): SettlementDispute {
    if (canViewPrivate(dispute, viewer)) return { ...dispute };
    return {
      ...dispute,
      evidence: dispute.evidence.filter((item) => item.visibility === "public"),
      notes: dispute.notes.filter((item) => item.visibility === "public")
    };
  }

  function auditTransition(
    actor: AuditActor,
    dispute: SettlementDispute,
    action: "settlement_dispute.opened" | "settlement_dispute.investigating" | "settlement_dispute.resolved" | "settlement_dispute.rejected" | "settlement_dispute.reopened",
    outcome: "allowed" | "denied",
    before: SettlementDisputeStatus,
    after: SettlementDisputeStatus,
    reason: string,
    correlationId: string,
    errorCode?: SettlementDisputeErrorCode
  ): boolean {
    const event = audit({
      id: newId(),
      action,
      actor,
      scope: actor.kind === "maintainer" ? "maintainer" : "own",
      target: { kind: "settlement_dispute", id: dispute.id },
      reason,
      outcome,
      before: { state: before, settlementId: dispute.settlementId },
      after: { state: after, evidenceCount: dispute.evidence.length, noteCount: dispute.notes.length },
      at: iso(now()),
      correlationId,
      errorCode
    });
    return event !== undefined;
  }

  function refuse(
    action: "settlement_dispute.opened" | "settlement_dispute.investigating" | "settlement_dispute.resolved" | "settlement_dispute.rejected" | "settlement_dispute.reopened",
    actor: AuditActor,
    dispute: SettlementDispute,
    code: SettlementDisputeErrorCode,
    reason: string,
    correlationId: string
  ): Result<never, SettlementDisputeErrorCode> {
    audit({
      id: newId(),
      action,
      actor,
      scope: actor.kind === "maintainer" ? "maintainer" : "own",
      target: { kind: "settlement_dispute", id: dispute.id },
      reason,
      outcome: "denied",
      after: { state: dispute.status },
      at: iso(now()),
      correlationId,
      errorCode: code
    });
    return err(code);
  }

  function mutateStatus(
    dispute: SettlementDispute,
    input: DisputeActionInput,
    event: "investigate" | "resolve" | "reject" | "reopen",
    action: "settlement_dispute.investigating" | "settlement_dispute.resolved" | "settlement_dispute.rejected" | "settlement_dispute.reopened",
    finalResolution?: string
  ): Result<SettlementDispute, SettlementDisputeErrorCode> {
    if (input.authorized === false || !isMaintainer(input.actor)) {
      return refuse(action, input.actor, dispute, "dispute_not_allowed", actionReason(input, action.split(".")[1]), input.correlationId ?? newId());
    }
    if (event === "reopen" && dispute.reopenedCount >= maxReopens) {
      return refuse(action, input.actor, dispute, "dispute_reopen_limit", actionReason(input, "reopen"), input.correlationId ?? newId());
    }
    if ((event === "resolve" || event === "reject") && (!finalResolution || finalResolution.length > 2000)) {
      return refuse(action, input.actor, dispute, "dispute_invalid_input", actionReason(input, "resolution"), input.correlationId ?? newId());
    }

    const resolved = settlementDisputeMachine.resolve(dispute.status, event);
    if (!resolved.ok) {
      return refuse(action, input.actor, dispute, "dispute_invalid_transition", actionReason(input, event), input.correlationId ?? newId());
    }

    const correlationId = input.correlationId ?? newId();
    const before = dispute.status;
    const after = resolved.value as SettlementDisputeStatus;
    const at = iso(now());
    const reason = actionReason(input, event);
    if (!auditTransition(input.actor, dispute, action, "allowed", before, after, reason, correlationId)) {
      return err("dispute_audit_failed");
    }
    const updated: SettlementDispute = {
      ...dispute,
      status: after,
      resolution: finalResolution ?? dispute.resolution,
      updatedAt: at,
      reopenedAt: event === "reopen" ? at : dispute.reopenedAt,
      reopenedCount: event === "reopen" ? dispute.reopenedCount + 1 : dispute.reopenedCount
    };
    disputes.set(updated.id, updated);
    return ok(updated);
  }

  return {
    open(input): Result<SettlementDispute, SettlementDisputeErrorCode> {
      const correlationId = input.correlationId ?? newId();
      const reason = actionReason(input, "dispute_opened");
      if (input.authorized === false) {
        const placeholder: SettlementDispute = {
          id: newId(), settlementId: input.settlementId, claimantId: input.claimantId ?? input.actor.id,
          status: "open", reason, createdAt: iso(now()), updatedAt: iso(now()),
          reopenedCount: 0, evidence: [], notes: [], correlationId
        };
        return refuse("settlement_dispute.opened", input.actor, placeholder, "dispute_not_allowed", reason, correlationId);
      }
      if (!ID_PATTERN.test(input.settlementId) || input.reason.length < 1 || input.reason.length > 2000) {
        const placeholder: SettlementDispute = {
          id: newId(), settlementId: input.settlementId, claimantId: input.claimantId ?? input.actor.id,
          status: "open", reason, createdAt: iso(now()), updatedAt: iso(now()),
          reopenedCount: 0, evidence: [], notes: [], correlationId
        };
        return refuse("settlement_dispute.opened", input.actor, placeholder, "dispute_invalid_input", reason, correlationId);
      }

      if (input.idempotencyKey) {
        for (const existing of disputes.values()) {
          if (existing.idempotencyKey === input.idempotencyKey) return ok(existing);
        }
      }
      for (const existing of disputes.values()) {
        if (existing.settlementId === input.settlementId) {
          return refuse("settlement_dispute.opened", input.actor, existing, "dispute_duplicate",
            reason, correlationId);
        }
      }

      const at = iso(now());
      const id = newId();
      const claimantId = input.claimantId ?? input.actor.id;
      const dispute: SettlementDispute = {
        id,
        settlementId: input.settlementId,
        claimantId,
        respondentId: input.respondentId,
        status: "open",
        reason: input.reason,
        createdAt: at,
        updatedAt: at,
        reopenedCount: 0,
        evidence: [],
        notes: [],
        idempotencyKey: input.idempotencyKey,
        correlationId
      };
      if (!auditTransition(input.actor, dispute, "settlement_dispute.opened", "allowed", "open", "open", reason, correlationId)) {
        return err("dispute_audit_failed");
      }

      let evidenceCount = 0;
      const evidence: DisputeEvidence[] = [];
      for (const item of input.evidence ?? []) {
        if (evidenceCount >= maxEvidence) break;
        if (!item.reference || item.reference.length > 512) continue;
        if (item.sha256 && !SHA256_PATTERN.test(item.sha256)) continue;
        evidence.push({
          ...item,
          id: newId(),
          addedBy: claimantId,
          at
        });
        evidenceCount++;
      }
      const notes: DisputeNote[] = [];
      for (const item of input.notes ?? []) {
        if (notes.length >= 25 || !item.text || item.text.length > 2000) continue;
        notes.push({ ...item, id: newId(), authorId: claimantId, at });
      }
      const created = { ...dispute, evidence, notes };
      disputes.set(id, created);
      return ok(created);
    },

    investigate(input) {
      const dispute = disputes.get(input.id);
      return dispute
        ? mutateStatus(dispute, input, "investigate", "settlement_dispute.investigating")
        : err("dispute_not_found");
    },

    resolve(input) {
      const dispute = disputes.get(input.id);
      return dispute
        ? mutateStatus(dispute, input, "resolve", "settlement_dispute.resolved", input.resolution)
        : err("dispute_not_found");
    },

    reject(input) {
      const dispute = disputes.get(input.id);
      return dispute
        ? mutateStatus(dispute, input, "reject", "settlement_dispute.rejected", input.resolution)
        : err("dispute_not_found");
    },

    reopen(input) {
      const dispute = disputes.get(input.id);
      return dispute
        ? mutateStatus(dispute, input, "reopen", "settlement_dispute.reopened")
        : err("dispute_not_found");
    },

    addEvidence(input) {
      const dispute = disputes.get(input.id);
      if (!dispute) return err("dispute_not_found");
      const mayAdd = input.authorized !== false && (
        isMaintainer(input.actor) ||
        (input.actor.kind === "user" && input.actor.id === dispute.claimantId)
      );
      if (!mayAdd) {
        audit({
          id: newId(),
          action: "settlement_dispute.evidence_added",
          actor: input.actor,
          scope: isMaintainer(input.actor) ? "maintainer" : "own",
          target: { kind: "settlement_dispute", id: dispute.id },
          reason: actionReason(input, "evidence_added"),
          outcome: "denied",
          after: { evidenceCount: dispute.evidence.length },
          at: iso(now()),
          correlationId: input.correlationId ?? newId(),
          errorCode: "dispute_not_allowed"
        });
        return err("dispute_not_allowed");
      }
      if (dispute.evidence.length >= maxEvidence || !input.evidence.reference || input.evidence.reference.length > 512 ||
        (input.evidence.sha256 && !SHA256_PATTERN.test(input.evidence.sha256))) {
        return err("dispute_invalid_input");
      }
      const at = iso(now());
      const correlationId = input.correlationId ?? newId();
      const event = audit({
        id: newId(),
        action: "settlement_dispute.evidence_added",
        actor: input.actor,
        scope: isMaintainer(input.actor) ? "maintainer" : "own",
        target: { kind: "settlement_dispute", id: dispute.id },
        reason: actionReason(input, "evidence_added"),
        outcome: "allowed",
        before: { evidenceCount: dispute.evidence.length },
        after: { evidenceCount: dispute.evidence.length + 1, visibility: input.evidence.visibility },
        at,
        correlationId
      });
      if (!event) return err("dispute_audit_failed");
      const evidence: DisputeEvidence = {
        ...input.evidence,
        id: newId(),
        addedBy: input.actor.id,
        at
      };
      const updated = { ...dispute, evidence: [...dispute.evidence, evidence], updatedAt: at };
      disputes.set(dispute.id, updated);
      return ok(updated);
    },

    addNote(input) {
      const dispute = disputes.get(input.id);
      if (!dispute) return err("dispute_not_found");
      const mayAdd = input.authorized !== false && (
        isMaintainer(input.actor) ||
        (input.actor.kind === "user" && input.actor.id === dispute.claimantId)
      );
      if (!mayAdd) {
        audit({
          id: newId(),
          action: "settlement_dispute.note_added",
          actor: input.actor,
          scope: isMaintainer(input.actor) ? "maintainer" : "own",
          target: { kind: "settlement_dispute", id: dispute.id },
          reason: actionReason(input, "note_added"),
          outcome: "denied",
          after: { noteCount: dispute.notes.length },
          at: iso(now()),
          correlationId: input.correlationId ?? newId(),
          errorCode: "dispute_not_allowed"
        });
        return err("dispute_not_allowed");
      }
      if (!input.note.text || input.note.text.length > 2000) return err("dispute_invalid_input");
      const at = iso(now());
      const correlationId = input.correlationId ?? newId();
      const event = audit({
        id: newId(),
        action: "settlement_dispute.note_added",
        actor: input.actor,
        scope: isMaintainer(input.actor) ? "maintainer" : "own",
        target: { kind: "settlement_dispute", id: dispute.id },
        reason: actionReason(input, "note_added"),
        outcome: "allowed",
        before: { noteCount: dispute.notes.length },
        after: { noteCount: dispute.notes.length + 1, visibility: input.note.visibility },
        at,
        correlationId
      });
      if (!event) return err("dispute_audit_failed");
      const note: DisputeNote = {
        ...input.note,
        id: newId(),
        authorId: input.actor.id,
        at
      };
      const updated = { ...dispute, notes: [...dispute.notes, note], updatedAt: at };
      disputes.set(dispute.id, updated);
      return ok(updated);
    },

    get(id, viewer) {
      const dispute = disputes.get(id);
      return dispute ? visible(dispute, viewer) : undefined;
    },

    list(viewer) {
      return [...disputes.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((dispute) => visible(dispute, viewer));
    },

    auditEvents() {
      return [...auditEvents];
    }
  };
}
