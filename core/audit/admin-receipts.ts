/**
 * Fail-closed, signed administrative change audit records. Signing occurs
 * after the input passes the existing audit redaction/validation boundary:
 * a detached signature cannot authenticate unsanitized or invalid metadata.
 */
import { createIsolatedAuditTrail, type AuditInput, type AuditEvent, type AuditReceiptSigner, type AuditTrail } from "@/core/audit/audit";
import { createSignedAuditReceipt, verifySignedAuditReceipt } from "@/core/audit/signed-receipt";
import { hasPermission } from "@/core/auth/types";
import type { AuthContext } from "@/core/auth/middleware";
import { err, ok, type Result } from "@/core/result/result";

export type AdminReceiptError = "unauthorized" | "invalid_change" | "signing_failed" | "audit_store_failed";

export function recordSignedAdminChange(
  trail: AuditTrail,
  auth: AuthContext,
  signer: AuditReceiptSigner,
  change: Pick<AuditInput, "target" | "before" | "after" | "reason" | "correlationId">,
  trustedPublicKeys: Readonly<Record<string, string>>
): Result<AuditEvent, AdminReceiptError> {
  if (!hasPermission(auth.role, "admin:config") || !auth.userId) return err("unauthorized");
  if (!signer.signerId || !Object.hasOwn(trustedPublicKeys, signer.signerId)) return err("signing_failed");

  // Prepare using the existing canonical audit validation and redaction path.
  const prepared = createIsolatedAuditTrail().record({
    ...change,
    action: "admin.config_changed",
    actor: { kind: "maintainer", id: auth.userId },
    scope: "maintainer",
    outcome: "allowed"
  });
  if (!prepared.ok) return err("invalid_change");
  try {
    const receipt = createSignedAuditReceipt(prepared.value, signer);
    const signed = { ...prepared.value, receipt };
    if (!verifySignedAuditReceipt(signed, trustedPublicKeys)) return err("signing_failed");
    const committed = trail.record({
      id: signed.id, action: signed.action, actor: signed.actor, scope: signed.scope,
      target: signed.target, outcome: signed.outcome, before: signed.before,
      after: signed.after, reason: signed.reason, at: signed.at,
      correlationId: signed.correlationId, receipt
    });
    if (!committed.ok) return err("audit_store_failed");
    if (!verifySignedAuditReceipt(committed.value, trustedPublicKeys)) return err("audit_store_failed");
    return ok(committed.value);
  } catch {
    return err("signing_failed");
  }
}
