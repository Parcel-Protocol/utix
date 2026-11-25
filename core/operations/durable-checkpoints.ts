/**
 * Durable Checkpoints Around External Side Effects (#438).
 *
 * Provides two-phase durable intent-and-confirmation checkpointing for operations
 * interacting with external networks, third-party APIs, and distributed ledgers:
 * - Pre-commit Intent: Durably records input hash, idempotency key, and status "intent"
 *   before any network request or external write occurs.
 * - Post-commit Confirmation: Records transaction receipts, ledger confirmations, and
 *   marks `sideEffectCommitted: true`.
 * - Ambiguous In-Doubt Handling: If a network disconnection occurs mid-flight, marks the
 *   checkpoint as "in_doubt" and halts automatic retries to prevent double-application.
 * - Compensating and Authorized Resolution: Operator-governed confirmation for stranded
 *   external states.
 */

import crypto from "node:crypto";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, isErr, ok, type Result } from "@/core/result/result";

export type DurableCheckpointPhase =
  | "intent"
  | "executing"
  | "committed"
  | "failed"
  | "in_doubt";

export interface ExternalReceipt {
  readonly transactionHash?: string;
  readonly externalId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DurableSideEffectCheckpoint<TOutput = unknown> {
  readonly id: string;
  readonly operationId: string;
  readonly stepId: string;
  readonly idempotencyKey: string;
  phase: DurableCheckpointPhase;
  sideEffectCommitted: boolean;
  readonly payloadHash: string;
  attempt: number;
  output?: TOutput;
  externalReceipt?: ExternalReceipt;
  errorCode?: string;
  errorMessage?: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface DurableCheckpointStore {
  readonly read: (id: string) => DurableSideEffectCheckpoint | undefined;
  readonly byKey: (idempotencyKey: string) => DurableSideEffectCheckpoint | undefined;
  readonly write: (checkpoint: DurableSideEffectCheckpoint) => void;
  readonly list: (filter?: {
    operationId?: string;
    phase?: DurableCheckpointPhase;
  }) => readonly DurableSideEffectCheckpoint[];
}

export function createMemoryDurableCheckpointStore(): DurableCheckpointStore {
  const byId = new Map<string, DurableSideEffectCheckpoint>();
  const byKeyMap = new Map<string, string>();

  return {
    read: (id) => byId.get(id),
    byKey: (key) => {
      const id = byKeyMap.get(key);
      return id ? byId.get(id) : undefined;
    },
    write: (checkpoint) => {
      byId.set(checkpoint.id, checkpoint);
      byKeyMap.set(checkpoint.idempotencyKey, checkpoint.id);
    },
    list: (filter) => {
      const all = Array.from(byId.values());
      return all.filter((cp) => {
        if (filter?.operationId && cp.operationId !== filter.operationId) return false;
        if (filter?.phase && cp.phase !== filter.phase) return false;
        return true;
      });
    }
  };
}

export interface ExecuteSideEffectInput<TInput, TOutput> {
  readonly store: DurableCheckpointStore;
  readonly operationId: string;
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly payload: TInput;
  readonly action: (
    input: TInput,
    checkpoint: DurableSideEffectCheckpoint
  ) => Promise<{ output: TOutput; externalReceipt?: ExternalReceipt }>;
  readonly isDefinitiveFailure?: (error: unknown) => boolean;
  readonly now?: () => number;
}

export type SideEffectExecutionErrorCode =
  | "external_effect_failed"
  | "external_effect_in_doubt";

function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
}

/**
 * Executes an external side effect with durable pre- and post-commit checkpoints.
 */
export async function executeWithDurableCheckpoint<TInput, TOutput>(
  input: ExecuteSideEffectInput<TInput, TOutput>
): Promise<Result<{ output: TOutput; checkpoint: DurableSideEffectCheckpoint<TOutput>; replayed: boolean }, SideEffectExecutionErrorCode>> {
  const nowFn = input.now ?? (() => Date.now());
  const nowIso = new Date(nowFn()).toISOString();
  const payloadHash = hashPayload(input.payload);

  // Check for existing checkpoint
  let checkpoint = input.store.byKey(input.idempotencyKey) as DurableSideEffectCheckpoint<TOutput> | undefined;

  if (checkpoint) {
    // If already committed, return stored output without repeating external effect
    if (checkpoint.phase === "committed" && checkpoint.output !== undefined) {
      return ok({ output: checkpoint.output, checkpoint, replayed: true });
    }

    // If in-doubt, refuse blind re-execution to protect against double-spend
    if (checkpoint.phase === "in_doubt") {
      return err("external_effect_in_doubt");
    }

    // Increment attempt count on retry
    checkpoint.attempt++;
    checkpoint.phase = "intent";
    checkpoint.updatedAt = nowIso;
    input.store.write(checkpoint);
  } else {
    // Pre-commit Intent Checkpoint
    checkpoint = {
      id: `cp-${input.operationId}-${input.stepId}-${Date.now()}`,
      operationId: input.operationId,
      stepId: input.stepId,
      idempotencyKey: input.idempotencyKey,
      phase: "intent",
      sideEffectCommitted: false,
      payloadHash,
      attempt: 1,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    input.store.write(checkpoint);
  }

  // Transition to executing
  checkpoint.phase = "executing";
  checkpoint.updatedAt = new Date(nowFn()).toISOString();
  input.store.write(checkpoint);

  try {
    const result = await input.action(input.payload, checkpoint);

    // Post-commit Confirmation Checkpoint
    checkpoint.phase = "committed";
    checkpoint.sideEffectCommitted = true;
    checkpoint.output = result.output;
    checkpoint.externalReceipt = result.externalReceipt;
    checkpoint.errorCode = undefined;
    checkpoint.errorMessage = undefined;
    checkpoint.updatedAt = new Date(nowFn()).toISOString();
    input.store.write(checkpoint);

    return ok({ output: result.output, checkpoint, replayed: false });
  } catch (error) {
    const isDefinitive = input.isDefinitiveFailure ? input.isDefinitiveFailure(error) : false;

    if (isDefinitive) {
      // Known definitive failure (e.g., 400 Bad Request, invalid signature before transaction hit ledger)
      checkpoint.phase = "failed";
      checkpoint.sideEffectCommitted = false;
      checkpoint.errorCode = "definitive_failure";
      checkpoint.errorMessage = error instanceof Error ? error.message : String(error);
      checkpoint.updatedAt = new Date(nowFn()).toISOString();
      input.store.write(checkpoint);
      return err("external_effect_failed");
    } else {
      // Ambiguous failure (e.g. timeout, network reset after request sent): MUST mark in-doubt
      checkpoint.phase = "in_doubt";
      checkpoint.sideEffectCommitted = true; // Guard against double apply
      checkpoint.errorCode = "timeout_or_disconnect";
      checkpoint.errorMessage = error instanceof Error ? error.message : String(error);
      checkpoint.updatedAt = new Date(nowFn()).toISOString();
      input.store.write(checkpoint);
      return err("external_effect_in_doubt");
    }
  }
}

/**
 * Resolves an in-doubt checkpoint after out-of-band confirmation.
 */
export function resolveInDoubtCheckpoint(
  store: DurableCheckpointStore,
  checkpointId: string,
  resolution: {
    readonly outcome: "applied" | "not_applied";
    readonly externalReceipt?: ExternalReceipt;
    readonly output?: unknown;
    readonly reason: string;
  }
): Result<DurableSideEffectCheckpoint, "checkpoint_not_found" | "not_in_doubt"> {
  const checkpoint = store.read(checkpointId);
  if (!checkpoint) return err("checkpoint_not_found");

  if (checkpoint.phase !== "in_doubt") {
    return err("not_in_doubt");
  }

  const nowIso = new Date().toISOString();
  if (resolution.outcome === "applied") {
    checkpoint.phase = "committed";
    checkpoint.sideEffectCommitted = true;
    if (resolution.externalReceipt) checkpoint.externalReceipt = resolution.externalReceipt;
    if (resolution.output !== undefined) checkpoint.output = resolution.output;
  } else {
    checkpoint.phase = "failed";
    checkpoint.sideEffectCommitted = false;
    checkpoint.errorMessage = `Resolved not applied: ${resolution.reason}`;
  }

  checkpoint.updatedAt = nowIso;
  store.write(checkpoint);
  return ok(checkpoint);
}

/**
 * Authorization-guarded resolution of an in-doubt checkpoint.
 */
export function resolveInDoubtCheckpointAuthorized(
  auth: AuthContext,
  store: DurableCheckpointStore,
  checkpointId: string,
  resolution: {
    readonly outcome: "applied" | "not_applied";
    readonly externalReceipt?: ExternalReceipt;
    readonly output?: unknown;
    readonly reason: string;
  }
): Result<DurableSideEffectCheckpoint, "permission_denied" | "checkpoint_not_found" | "not_in_doubt"> {
  if (!hasPermission(auth.role, "admin:recovery") && auth.role !== "maintainer") {
    return err("permission_denied");
  }

  return resolveInDoubtCheckpoint(store, checkpointId, resolution);
}
