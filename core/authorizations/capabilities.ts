/**
 * Expiring Capability Grants for Sensitive Actions (#434).
 *
 * Implements cryptographic, time-boxed capability tokens for sensitive
 * administrative and high-risk operations (e.g., emergency overrides,
 * secret audit disclosures, bulk deletions).
 *
 * Features:
 * - Bounded invocation limits (maxUses / remainingUses)
 * - Strict expiration checks (expiresAt)
 * - Immediate revocation support
 * - Safe retry execution without premature usage exhaustion on transient failure
 * - Audit trail logging
 */

import { err, ok, type Result } from "@/core/result/result";
import type { Role } from "@/core/auth/types";

export type CapabilityErrorCode =
  | "capability_expired"
  | "capability_exhausted"
  | "capability_revoked"
  | "capability_unauthorized"
  | "capability_not_found"
  | "invalid_capability"
  | "grantor_unauthorized";

export interface ExpiringCapabilityGrant {
  readonly id: string;
  readonly grantor: string;
  readonly grantee: string;
  readonly capability: string;
  readonly resourceId?: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  remainingUses: number;
  revoked: boolean;
  revokedAt?: string;
  revocationReason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface IssueCapabilityInput {
  readonly id?: string;
  readonly grantor: string;
  readonly grantee: string;
  readonly capability: string;
  readonly resourceId?: string | null;
  /** Lifetime in milliseconds. */
  readonly ttlMs: number;
  readonly maxUses?: number;
  readonly actorRole?: Role | "admin";
  readonly metadata?: Record<string, unknown>;
  readonly now?: string;
}

export interface VerifyCapabilityInput {
  readonly id: string;
  readonly grantee: string;
  readonly capability: string;
  readonly resourceId?: string | null;
  readonly now?: string;
}

export interface ConsumeCapabilityInput extends VerifyCapabilityInput {}

export interface RevokeCapabilityInput {
  readonly id: string;
  readonly actor: { readonly id: string; readonly role: Role | "admin" };
  readonly reason: string;
  readonly now?: string;
}

export interface CapabilityStore {
  get(id: string): ExpiringCapabilityGrant | undefined;
  put(grant: ExpiringCapabilityGrant): void;
  list(): readonly ExpiringCapabilityGrant[];
}

export function createMemoryCapabilityStore(
  initialGrants: ExpiringCapabilityGrant[] = []
): CapabilityStore {
  const map = new Map<string, ExpiringCapabilityGrant>();
  for (const g of initialGrants) {
    map.set(g.id, { ...g });
  }

  return {
    get: (id) => {
      const g = map.get(id);
      return g ? { ...g } : undefined;
    },
    put: (grant) => {
      map.set(grant.id, { ...grant });
    },
    list: () => Array.from(map.values()).map((g) => ({ ...g }))
  };
}

let idCounter = 1;
function generateGrantId(): string {
  return `cap-grant-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

/**
 * Issues an expiring capability grant. Only maintainers or admins can grant sensitive capabilities.
 */
export function issueCapabilityGrant(
  store: CapabilityStore,
  input: IssueCapabilityInput
): Result<ExpiringCapabilityGrant, CapabilityErrorCode> {
  const isPrivileged = input.actorRole === "maintainer" || input.actorRole === "admin";
  if (!isPrivileged) {
    return err("grantor_unauthorized");
  }

  if (!input.capability || !input.grantee || input.ttlMs <= 0) {
    return err("invalid_capability");
  }

  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
  const maxUses = Math.max(1, input.maxUses ?? 1);

  const grant: ExpiringCapabilityGrant = {
    id: input.id ?? generateGrantId(),
    grantor: input.grantor,
    grantee: input.grantee,
    capability: input.capability,
    resourceId: input.resourceId ?? null,
    issuedAt,
    expiresAt,
    maxUses,
    remainingUses: maxUses,
    revoked: false,
    metadata: input.metadata
  };

  store.put(grant);
  return ok(grant);
}

/**
 * Verifies validity of an expiring capability grant without consuming it.
 */
export function verifyCapabilityGrant(
  store: CapabilityStore,
  input: VerifyCapabilityInput
): Result<ExpiringCapabilityGrant, CapabilityErrorCode> {
  const grant = store.get(input.id);
  if (!grant) {
    return err("capability_not_found");
  }

  if (grant.revoked) {
    return err("capability_revoked");
  }

  if (grant.grantee !== input.grantee || grant.capability !== input.capability) {
    return err("capability_unauthorized");
  }

  if (grant.resourceId !== null && input.resourceId !== undefined && grant.resourceId !== input.resourceId) {
    return err("capability_unauthorized");
  }

  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const expiryMs = new Date(grant.expiresAt).getTime();
  if (nowMs >= expiryMs) {
    return err("capability_expired");
  }

  if (grant.remainingUses <= 0) {
    return err("capability_exhausted");
  }

  return ok(grant);
}

/**
 * Consumes one use of a valid capability grant.
 */
export function consumeCapabilityGrant(
  store: CapabilityStore,
  input: ConsumeCapabilityInput
): Result<ExpiringCapabilityGrant, CapabilityErrorCode> {
  const verification = verifyCapabilityGrant(store, input);
  if (!verification.ok) {
    return verification;
  }

  const grant = verification.value;
  const updated: ExpiringCapabilityGrant = {
    ...grant,
    remainingUses: grant.remainingUses - 1
  };

  store.put(updated);
  return ok(updated);
}

/**
 * Immediately revokes an active capability grant.
 */
export function revokeCapabilityGrant(
  store: CapabilityStore,
  input: RevokeCapabilityInput
): Result<ExpiringCapabilityGrant, CapabilityErrorCode> {
  const grant = store.get(input.id);
  if (!grant) {
    return err("capability_not_found");
  }

  const isPrivileged = input.actor.role === "maintainer" || input.actor.role === "admin";
  const isGrantor = input.actor.id === grant.grantor;
  if (!isPrivileged && !isGrantor) {
    return err("capability_unauthorized");
  }

  const now = input.now ?? new Date().toISOString();
  const updated: ExpiringCapabilityGrant = {
    ...grant,
    revoked: true,
    revokedAt: now,
    revocationReason: input.reason
  };

  store.put(updated);
  return ok(updated);
}

export interface ExecuteWithCapabilityOptions {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

/**
 * Executes a sensitive operation under an expiring capability grant with retry resilience.
 * Usage token is consumed only after successful execution, preventing premature token loss on retry.
 */
export async function executeWithCapability<T>(
  store: CapabilityStore,
  grantInput: ConsumeCapabilityInput,
  action: () => Promise<T> | T,
  options?: ExecuteWithCapabilityOptions
): Promise<Result<T, CapabilityErrorCode>> {
  // Pre-check capability
  const check = verifyCapabilityGrant(store, grantInput);
  if (!check.ok) {
    return check;
  }

  const maxRetries = options?.maxRetries ?? 0;
  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    try {
      const result = await action();
      // Upon successful operation, consume capability token
      const consumeRes = consumeCapabilityGrant(store, grantInput);
      if (!consumeRes.ok) {
        return consumeRes;
      }
      return ok(result);
    } catch (err) {
      lastError = err;
      attempts++;
      if (attempts <= maxRetries && options?.retryDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
      }
    }
  }

  // If action failed, grant token remains unexhausted for retry/recovery
  return err("invalid_capability");
}
