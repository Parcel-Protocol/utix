import type { AuditActor, AuditEvent } from "@/core/audit/audit";

export type SettlementDisputeStatus =
  | "open"
  | "investigating"
  | "resolved"
  | "rejected"
  | "reopened";

export type EvidenceVisibility = "public" | "private";

export interface DisputeEvidence {
  readonly id: string;
  readonly kind: "document" | "transaction" | "identity" | "message" | "other";
  readonly visibility: EvidenceVisibility;
  readonly reference: string;
  readonly description?: string;
  readonly sha256?: string;
  readonly addedBy: string;
  readonly at: string;
}

export interface DisputeNote {
  readonly id: string;
  readonly visibility: EvidenceVisibility;
  readonly text: string;
  readonly authorId: string;
  readonly at: string;
}

export interface SettlementDispute {
  readonly id: string;
  readonly settlementId: string;
  readonly claimantId: string;
  readonly respondentId?: string;
  readonly status: SettlementDisputeStatus;
  readonly reason: string;
  readonly resolution?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reopenedAt?: string;
  readonly reopenedCount: number;
  readonly evidence: readonly DisputeEvidence[];
  readonly notes: readonly DisputeNote[];
  readonly idempotencyKey?: string;
  readonly correlationId: string;
}

export type SettlementDisputeErrorCode =
  | "dispute_not_found"
  | "dispute_duplicate"
  | "dispute_not_allowed"
  | "dispute_invalid_input"
  | "dispute_invalid_transition"
  | "dispute_audit_failed"
  | "dispute_already_resolved"
  | "dispute_reopen_limit";

export interface OpenSettlementDisputeInput {
  readonly actor: AuditActor;
  readonly settlementId: string;
  readonly claimantId?: string;
  readonly respondentId?: string;
  readonly reason: string;
  readonly authorized?: boolean;
  readonly evidence?: readonly Omit<DisputeEvidence, "id" | "addedBy" | "at">[];
  readonly notes?: readonly Omit<DisputeNote, "id" | "authorId" | "at">[];
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

export interface DisputeActionInput {
  readonly actor: AuditActor;
  readonly id: string;
  readonly authorized?: boolean;
  readonly reason?: string;
  readonly resolution?: string;
  readonly correlationId?: string;
}

export interface AddEvidenceInput {
  readonly actor: AuditActor;
  readonly id: string;
  readonly evidence: Omit<DisputeEvidence, "id" | "addedBy" | "at">;
  readonly authorized?: boolean;
  readonly reason?: string;
  readonly correlationId?: string;
}

export interface AddNoteInput {
  readonly actor: AuditActor;
  readonly id: string;
  readonly note: Omit<DisputeNote, "id" | "authorId" | "at">;
  readonly authorized?: boolean;
  readonly reason?: string;
  readonly correlationId?: string;
}

export interface SettlementDisputeStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly record?: (input: import("@/core/audit/audit").AuditInput) => AuditEvent | undefined;
  readonly maxReopens?: number;
  readonly maxEvidence?: number;
}
