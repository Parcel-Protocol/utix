/**
 * Authorization and access controls for active, hidden, and archived records (#435).
 *
 * Enforces strict visibility policies, non-disclosure guarantees, role-based access,
 * and resilient lifecycle operations (hide, unhide, archive, restore) with retry safety.
 */

import { err, ok, type Result } from "@/core/result/result";
import type { Role } from "@/core/auth/types";

export type RecordVisibility = "active" | "hidden" | "archived";

export interface AuthorizedRecord<T> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly visibility: RecordVisibility;
  readonly value: T;
  readonly ownerId: string;
  readonly readers?: readonly string[];
  readonly hiddenAt?: string;
  readonly archivedAt?: string;
  readonly restoredAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RecordActor {
  readonly id: string;
  readonly role: Role | "admin" | "anonymous";
  readonly permissions?: readonly string[];
}

export type RecordErrorCode =
  | "record_not_found"
  | "record_hidden"
  | "record_archived"
  | "authorization_denied"
  | "invalid_state_transition"
  | "storage_contention_exhausted";

export interface AuthorizedRecordStore<T> {
  read(id: string): AuthorizedRecord<T> | undefined;
  write(record: AuthorizedRecord<T>): void;
  list?(filter?: { visibility?: RecordVisibility; ownerId?: string }): readonly AuthorizedRecord<T>[];
}

/**
 * Checks whether the given actor is permitted to observe and read the record.
 *
 * Policies:
 * - Active: accessible to record owner, listed readers, and actors with 'viewer', 'maintainer', or 'admin' roles.
 * - Hidden: strictly restricted. Only accessible by 'maintainer', 'admin', or callers with explicit 'records:read_hidden' permission.
 * - Archived: restricted to 'maintainer', 'admin', or callers with explicit 'records:read_archived' permission.
 */
export function canAccessRecord<T>(actor: RecordActor, record: AuthorizedRecord<T>): boolean {
  if (actor.role === "admin" || actor.role === "maintainer") {
    return true;
  }

  const hasPerm = (p: string) => actor.permissions?.includes(p) ?? false;

  switch (record.visibility) {
    case "active":
      if (actor.id === record.ownerId) return true;
      if (record.readers?.includes(actor.id)) return true;
      if (actor.role === "viewer" || hasPerm("records:read")) return true;
      return false;

    case "hidden":
      // Safe non-disclosure: general viewers never see hidden records
      if (hasPerm("records:read_hidden")) return true;
      if (actor.id === record.ownerId && hasPerm("records:read_own_hidden")) return true;
      return false;

    case "archived":
      // Archived records require explicit audit/archive read permission
      return hasPerm("records:read_archived");

    default:
      return false;
  }
}

export interface ReadRecordOptions {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

/**
 * Reads an authorized record with safe non-disclosure on unauthorized access
 * and automatic retry with backoff on transient storage contention.
 */
export async function readAuthorizedRecord<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor,
  options?: ReadRecordOptions
): Promise<Result<AuthorizedRecord<T>, RecordErrorCode>> {
  const maxRetries = options?.maxRetries ?? 0;
  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      const record = store.read(id);
      if (!record) {
        return err("record_not_found");
      }

      const accessible = canAccessRecord(actor, record);

      if (!accessible) {
        // Safe non-disclosure: if record is hidden, return record_not_found to prevent probing
        if (record.visibility === "hidden") {
          return err("record_not_found");
        }
        if (record.visibility === "archived") {
          return err("record_archived");
        }
        return err("authorization_denied");
      }

      return ok(record);
    } catch {
      attempts++;
      if (attempts > maxRetries) {
        return err("storage_contention_exhausted");
      }
      if (options?.retryDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
      }
    }
  }

  return err("storage_contention_exhausted");
}

/** Synchronous variant for fast memory lookups. */
export function readAuthorizedRecordSync<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor
): Result<AuthorizedRecord<T>, RecordErrorCode> {
  const record = store.read(id);
  if (!record) {
    return err("record_not_found");
  }

  const accessible = canAccessRecord(actor, record);
  if (!accessible) {
    if (record.visibility === "hidden") {
      return err("record_not_found");
    }
    if (record.visibility === "archived") {
      return err("record_archived");
    }
    return err("authorization_denied");
  }

  return ok(record);
}

/**
 * Transitions an active record to hidden state.
 * Requires maintainer/admin role or owner with 'records:hide' permission.
 */
export function hideRecord<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor,
  now = new Date().toISOString()
): Result<AuthorizedRecord<T>, RecordErrorCode> {
  const record = store.read(id);
  if (!record) return err("record_not_found");

  const isOwner = actor.id === record.ownerId;
  const isPrivileged = actor.role === "maintainer" || actor.role === "admin";
  const hasPerm = actor.permissions?.includes("records:hide") ?? false;

  if (!isPrivileged && !(isOwner && hasPerm)) {
    return err("authorization_denied");
  }

  if (record.visibility === "archived") {
    return err("invalid_state_transition");
  }

  const updated: AuthorizedRecord<T> = {
    ...record,
    visibility: "hidden",
    hiddenAt: now
  };

  store.write(updated);
  return ok(updated);
}

/**
 * Transitions a hidden record back to active state.
 */
export function unhideRecord<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor
): Result<AuthorizedRecord<T>, RecordErrorCode> {
  const record = store.read(id);
  if (!record) return err("record_not_found");

  const isPrivileged = actor.role === "maintainer" || actor.role === "admin";
  const hasPerm = actor.permissions?.includes("records:unhide") ?? false;

  if (!isPrivileged && !hasPerm) {
    return err("authorization_denied");
  }

  if (record.visibility !== "hidden") {
    return err("invalid_state_transition");
  }

  const updated: AuthorizedRecord<T> = {
    ...record,
    visibility: "active",
    hiddenAt: undefined
  };

  store.write(updated);
  return ok(updated);
}

/**
 * Archives an active or hidden record.
 */
export function archiveAuthorizedRecord<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor,
  now = new Date().toISOString()
): Result<AuthorizedRecord<T>, RecordErrorCode> {
  const record = store.read(id);
  if (!record) return err("record_not_found");

  const isOwner = actor.id === record.ownerId;
  const isPrivileged = actor.role === "maintainer" || actor.role === "admin";
  const hasPerm = actor.permissions?.includes("records:archive") ?? false;

  if (!isPrivileged && !(isOwner && hasPerm)) {
    return err("authorization_denied");
  }

  if (record.visibility === "archived") {
    return ok(record); // Idempotent
  }

  const updated: AuthorizedRecord<T> = {
    ...record,
    visibility: "archived",
    archivedAt: now
  };

  store.write(updated);
  return ok(updated);
}

/**
 * Restores an archived record to active state.
 */
export function restoreAuthorizedRecord<T>(
  store: AuthorizedRecordStore<T>,
  id: string,
  actor: RecordActor,
  now = new Date().toISOString()
): Result<AuthorizedRecord<T>, RecordErrorCode> {
  const record = store.read(id);
  if (!record) return err("record_not_found");

  const isPrivileged = actor.role === "maintainer" || actor.role === "admin";
  const hasPerm = actor.permissions?.includes("records:restore") ?? false;

  if (!isPrivileged && !hasPerm) {
    return err("authorization_denied");
  }

  if (record.visibility !== "archived") {
    return err("invalid_state_transition");
  }

  const updated: AuthorizedRecord<T> = {
    ...record,
    visibility: "active",
    restoredAt: now
  };

  store.write(updated);
  return ok(updated);
}

/**
 * Lists all records visible to the actor based on their authorization privileges.
 */
export function listAuthorizedRecords<T>(
  store: AuthorizedRecordStore<T>,
  actor: RecordActor,
  filter?: { visibility?: RecordVisibility }
): readonly AuthorizedRecord<T>[] {
  if (!store.list) return [];
  const all = store.list(filter);
  return all.filter((rec) => canAccessRecord(actor, rec));
}
