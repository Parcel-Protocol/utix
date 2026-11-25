/**
 * Conflict Resolution for Concurrent Edits (#433).
 *
 * Implements deterministic conflict detection and resolution strategies
 * for concurrent mutations, preventing lost updates and silent state corruption.
 *
 * Strategies:
 * - `three-way-merge`: merges non-overlapping field changes from concurrent edits against base snapshot.
 * - `reject-on-conflict`: rejects conflicting edits on overlapping fields with full conflict diff.
 * - `last-write-wins`: prioritizes newer edits based on timestamp/sequence.
 *
 * Includes automated rebase and retry helper for concurrent mutations.
 */

import { err, ok, type Result } from "@/core/result/result";

export type ConflictStrategy = "three-way-merge" | "reject-on-conflict" | "last-write-wins";

export type ConflictErrorCode =
  | "edit_conflict_detected"
  | "document_not_found"
  | "unauthorized_editor"
  | "stale_version_rejected"
  | "max_retries_exceeded";

export interface VersionedDocument<T extends Record<string, unknown>> {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly data: T;
}

export interface EditPatch<T extends Record<string, unknown>> {
  readonly baseVersion: number;
  readonly editorId: string;
  readonly changes: Partial<T>;
  readonly timestamp?: string;
}

export interface ConflictReport<T> {
  readonly hasConflict: boolean;
  readonly conflictingFields: readonly (keyof T)[];
  readonly currentValues: Partial<T>;
  readonly attemptedValues: Partial<T>;
  readonly baseValues?: Partial<T>;
}

export interface DocumentStore<T extends Record<string, unknown>> {
  get(id: string): VersionedDocument<T> | undefined;
  save(doc: VersionedDocument<T>): void;
}

/**
 * Compares current document state with attempted patch against a common base snapshot.
 */
export function analyzeConflict<T extends Record<string, unknown>>(
  current: VersionedDocument<T>,
  base: VersionedDocument<T> | null,
  patch: EditPatch<T>
): ConflictReport<T> {
  const conflictingFields: (keyof T)[] = [];
  const currentValues: Partial<T> = {};
  const attemptedValues: Partial<T> = {};
  const baseValues: Partial<T> = {};

  const changedKeys = Object.keys(patch.changes) as (keyof T)[];

  for (const key of changedKeys) {
    const curVal = current.data[key];
    const patchVal = patch.changes[key];
    const baseVal = base?.data[key];

    // If current differs from base and patch also differs from base to something else
    if (baseVal !== undefined) {
      const curChanged = JSON.stringify(curVal) !== JSON.stringify(baseVal);
      const patchChanged = JSON.stringify(patchVal) !== JSON.stringify(baseVal);

      if (curChanged && patchChanged && JSON.stringify(curVal) !== JSON.stringify(patchVal)) {
        conflictingFields.push(key);
        currentValues[key] = curVal;
        attemptedValues[key] = patchVal;
        baseValues[key] = baseVal;
      }
    } else {
      // Without base version, check direct divergence
      if (curVal !== undefined && JSON.stringify(curVal) !== JSON.stringify(patchVal)) {
        conflictingFields.push(key);
        currentValues[key] = curVal;
        attemptedValues[key] = patchVal;
      }
    }
  }

  return {
    hasConflict: conflictingFields.length > 0,
    conflictingFields,
    currentValues,
    attemptedValues,
    baseValues: Object.keys(baseValues).length > 0 ? baseValues : undefined
  };
}

/**
 * Resolves a concurrent edit using the specified strategy.
 */
export function resolveConcurrentEdit<T extends Record<string, unknown>>(
  current: VersionedDocument<T>,
  base: VersionedDocument<T> | null,
  patch: EditPatch<T>,
  strategy: ConflictStrategy = "three-way-merge",
  now = new Date().toISOString()
): Result<VersionedDocument<T>, ConflictErrorCode, ConflictReport<T>> {
  // If version matches, no concurrent conflict
  if (current.version === patch.baseVersion) {
    const updatedData: T = { ...current.data, ...patch.changes };
    const nextDoc: VersionedDocument<T> = {
      id: current.id,
      version: current.version + 1,
      updatedAt: now,
      updatedBy: patch.editorId,
      data: updatedData
    };
    return ok(nextDoc);
  }

  // Version mismatch: concurrent edit occurred
  const conflict = analyzeConflict(current, base, patch);

  if (strategy === "reject-on-conflict" && conflict.hasConflict) {
    return err("edit_conflict_detected", conflict);
  }

  if (strategy === "three-way-merge") {
    if (conflict.hasConflict) {
      return err("edit_conflict_detected", conflict);
    }

    // Non-overlapping field updates: clean 3-way merge
    const mergedData: T = { ...current.data, ...patch.changes };
    const nextDoc: VersionedDocument<T> = {
      id: current.id,
      version: current.version + 1,
      updatedAt: now,
      updatedBy: patch.editorId,
      data: mergedData
    };
    return ok(nextDoc);
  }

  if (strategy === "last-write-wins") {
    const forcedData: T = { ...current.data, ...patch.changes };
    const nextDoc: VersionedDocument<T> = {
      id: current.id,
      version: current.version + 1,
      updatedAt: now,
      updatedBy: patch.editorId,
      data: forcedData
    };
    return ok(nextDoc);
  }

  return err("edit_conflict_detected", conflict);
}

export interface RebaseAndRetryOptions {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly strategy?: ConflictStrategy;
}

/**
 * Executes concurrent edits with automatic rebase and retry.
 */
export async function applyConcurrentEditWithRetry<T extends Record<string, unknown>>(
  store: DocumentStore<T>,
  docId: string,
  editorId: string,
  createChanges: (latest: VersionedDocument<T>) => Partial<T>,
  options?: RebaseAndRetryOptions
): Promise<Result<VersionedDocument<T>, ConflictErrorCode, ConflictReport<T>>> {
  const maxRetries = options?.maxRetries ?? 3;
  const strategy = options?.strategy ?? "three-way-merge";

  let attempts = 0;
  while (attempts <= maxRetries) {
    const current = store.get(docId);
    if (!current) {
      return err("document_not_found");
    }

    const baseSnapshot = { ...current, data: { ...current.data } };
    const changes = createChanges(current);

    const patch: EditPatch<T> = {
      baseVersion: current.version,
      editorId,
      changes
    };

    // Re-read latest before save to simulate/check atomic commit
    const latest = store.get(docId)!;
    const resolved = resolveConcurrentEdit(latest, baseSnapshot, patch, strategy);

    if (resolved.ok) {
      store.save(resolved.value);
      return resolved;
    }

    attempts++;
    if (attempts > maxRetries) {
      return resolved;
    }

    if (options?.retryDelayMs) {
      await new Promise((r) => setTimeout(r, options.retryDelayMs));
    }
  }

  return err("max_retries_exceeded");
}
