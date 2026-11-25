/**
 * Read-only financial and ownership invariant probe. The ledger is the source
 * of truth for balances; this monitor never rewrites a cached projection.
 */
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { DomainInvariantChecker } from "@/core/invariants/checker";
import type { DomainState } from "@/core/invariants/types";
import { reconcile, type ReconciliationInput } from "@/core/reconciliation/reconciliation";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

export interface InvariantMonitorReport {
  correlationId: string;
  status: "healthy" | "unhealthy";
  checkedAt: string;
  balanceFindings: number;
  ownershipFindings: number;
  violations: readonly { id: string; severity: string; entityId: string }[];
}

export function monitorFinancialInvariants(
  auth: AuthContext,
  state: DomainState,
  snapshot: ReconciliationInput,
  correlationId = newCorrelationId()
): Result<InvariantMonitorReport, "unauthorized"> {
  if (!hasPermission(auth.role, "admin:health")) return err("unauthorized");

  const domainViolations = DomainInvariantChecker.verifyAll(state);
  const reconciliation = reconcile(snapshot, correlationId);
  const balance = reconciliation.findings.filter((entry) => entry.invariant.startsWith("balance."));
  // A transferred ticket's current owner must match the latest transfer.
  // Other ticket states may have no transfer history, so they are excluded.
  const latestByTicket = new Map<string, { toAddress: string; timestamp: number }>();
  for (const transfer of state.transfers) {
    const previous = latestByTicket.get(transfer.ticketId);
    if (!previous || transfer.timestamp > previous.timestamp) {
      latestByTicket.set(transfer.ticketId, { toAddress: transfer.toAddress, timestamp: transfer.timestamp });
    }
  }
  const ownershipMismatches = [...state.tickets.values()]
    .filter((ticket) => ticket.status === "transferred" &&
      latestByTicket.has(ticket.id) &&
      latestByTicket.get(ticket.id)!.toAddress !== ticket.ownerAddress)
    .map((ticket) => ({
      id: "INV-02",
      severity: "critical",
      entityId: ticket.id
    }));
  const ownership = domainViolations.filter((entry) => entry.invariantId === "INV-11");
  const violations = [
    ...balance.map((entry) => ({ id: entry.invariant, severity: entry.severity, entityId: entry.recordId })),
    ...domainViolations.map((entry) => ({ id: entry.invariantId, severity: entry.severity, entityId: entry.entityId })),
    ...ownershipMismatches
  ];
  const status = violations.length ? "unhealthy" : "healthy";
  emitTelemetry({
    op: "health.invariant_monitor",
    actorType: "system",
    correlationId,
    result: status === "healthy" ? "success" : "failure",
    errorCode: status === "unhealthy" ? "invariant_violation" : undefined,
    payload: { balanceFindings: balance.length, ownershipFindings: ownership.length + ownershipMismatches.length, violations: violations.length }
  });
  return ok({
    correlationId,
    status,
    checkedAt: new Date(snapshot.now).toISOString(),
    balanceFindings: balance.length,
    ownershipFindings: ownership.length + ownershipMismatches.length,
    violations
  });
}
