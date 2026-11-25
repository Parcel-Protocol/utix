/**
 * Versioned Event Replay for Derived Projections (#439).
 *
 * Implements deterministic event replay and state projection across versioned event
 * streams, supporting event schema migration (upcasters), isolated slot rebuilding,
 * point-in-time reconstruction, atomic promotion, and clean rollback.
 */

import { recordAudit } from "@/core/audit/audit";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, isErr, ok, type Result } from "@/core/result/result";
import {
  createMemoryProjectionStore,
  createUpcasterRegistry,
  promoteProjection,
  replayProjection,
  rollbackProjection,
  type EventSource,
  type ProjectionDefinition,
  type ProjectionSlot,
  type ProjectionStore,
  type ReplayDeps,
  type ReplayErrorCode,
  type ReplayEvent,
  type ReplayFailure,
  type ReplayOptions,
  type ReplayReport,
  type UpcasterRegistry
} from "@/core/replay";

export const DERIVED_PROJECTION_PERMISSION = "admin:replay";

export interface DerivedProjectionSpec<TState> {
  readonly name: string;
  readonly version: number;
  readonly eventVersions: Readonly<Record<string, number>>;
  readonly initial: () => TState;
  readonly apply: (state: TState, event: ReplayEvent) => TState;
  readonly validate?: (state: TState) => readonly string[];
}

export interface DerivedProjectionReplayOptions {
  readonly mode?: "rebuild" | "resume" | "dryRun";
  readonly promote?: boolean;
  readonly untilSequence?: number;
  readonly maxRetries?: number;
  readonly batchSize?: number;
  readonly maxSkipped?: number;
  readonly poisonPolicy?: "halt" | "skip";
}

export interface DerivedProjectionReport<TState> {
  readonly projectionName: string;
  readonly version: number;
  readonly status: "ready" | "promoted" | "dry_run" | "failed";
  readonly activeVersion?: number;
  readonly eventsProcessed: number;
  readonly lastSequence: number;
  readonly state: TState;
  readonly violations: readonly string[];
}

/**
 * Replays versioned events to build or update a derived projection.
 */
export async function buildDerivedProjection<TState>(
  spec: DerivedProjectionSpec<TState>,
  deps: ReplayDeps,
  options?: DerivedProjectionReplayOptions
): Promise<Result<DerivedProjectionReport<TState>, ReplayErrorCode, ReplayFailure>> {
  if (!spec.name || spec.version < 1) {
    return err("invalid_options", {
      projection: spec.name,
      version: spec.version,
      code: "invalid_options",
      message: "Derived projection name and version >= 1 are required",
      checkpoint: 0,
      at: new Date().toISOString()
    });
  }

  const def: ProjectionDefinition<TState> = {
    name: spec.name,
    version: spec.version,
    eventVersions: spec.eventVersions,
    initial: spec.initial,
    apply: spec.apply,
    validate: spec.validate
  };

  const replayResult = await replayProjection(def, deps, {
    mode: options?.mode,
    promote: options?.promote,
    untilSequence: options?.untilSequence,
    maxRetries: options?.maxRetries,
    batchSize: options?.batchSize,
    maxSkipped: options?.maxSkipped,
    poisonPolicy: options?.poisonPolicy
  });

  if (isErr(replayResult)) {
    return err(replayResult.code, replayResult.detail);
  }

  const report = replayResult.value;
  const active = await deps.store.getActive(spec.name);
  const slot = await deps.store.getSlot(spec.name, spec.version);
  const state = (report.state ?? (slot?.state as TState)) as TState;

  return ok({
    projectionName: spec.name,
    version: spec.version,
    status: report.status,
    activeVersion: active?.version,
    eventsProcessed: report.eventsRead,
    lastSequence: report.toSequence ?? slot?.checkpoint ?? 0,
    state,
    violations: report.violations ?? []
  });
}

/**
 * Authorization-guarded build for derived projections.
 */
export async function buildDerivedProjectionAuthorized<TState>(
  auth: AuthContext,
  spec: DerivedProjectionSpec<TState>,
  deps: Omit<ReplayDeps, "auth">,
  options?: DerivedProjectionReplayOptions
): Promise<Result<DerivedProjectionReport<TState>, ReplayErrorCode, ReplayFailure>> {
  if (!hasPermission(auth.role, DERIVED_PROJECTION_PERMISSION) && auth.role !== "maintainer") {
    return err("permission_denied", {
      projection: spec.name,
      version: spec.version,
      code: "permission_denied",
      message: `Role "${auth.role}" is unauthorized to replay projections`,
      checkpoint: 0,
      at: new Date().toISOString()
    });
  }

  return buildDerivedProjection(spec, { ...deps, auth }, options);
}

/**
 * Rolls back an active derived projection to its previous version.
 */
export async function rollbackDerivedProjection(
  name: string,
  deps: ReplayDeps
): Promise<Result<{ previousVersion: number; activeVersion: number }, ReplayErrorCode>> {
  const result = await rollbackProjection(name, deps);
  if (isErr(result)) {
    return err(result.code);
  }
  return ok({
    previousVersion: result.value.fromVersion,
    activeVersion: result.value.toVersion
  });
}

/**
 * Authorization-guarded rollback of an active derived projection.
 */
export async function rollbackDerivedProjectionAuthorized(
  auth: AuthContext,
  name: string,
  deps: Omit<ReplayDeps, "auth">
): Promise<Result<{ previousVersion: number; activeVersion: number }, ReplayErrorCode>> {
  if (!hasPermission(auth.role, DERIVED_PROJECTION_PERMISSION) && auth.role !== "maintainer") {
    return err("permission_denied");
  }

  return rollbackDerivedProjection(name, { ...deps, auth });
}
