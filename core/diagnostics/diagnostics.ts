/**
 * Local Contributor Diagnostics Command (#416 / #275)
 *
 * Provides a single entry point for running contributor diagnostics locally.
 * Implements the authorization path described in the types module: an actor
 * must supply the `diagnostics:run` permission. Callers without it receive an
 * authorization failure report with an empty checks array rather than partial
 * results.
 *
 * Edge cases & recovery:
 * - Missing actor: returns `authorization: { allowed: false, reason: "missing_actor" }`.
 * - Actor present but missing permission: returns `authorization: { allowed: false, reason: "missing_permission" }`.
 * - Transient failures are retried by the runner; the suite itself holds no state,
 *   so there is nothing to roll back.
 */

import { runContributorDiagnostics } from "./runner.ts";
import {
  DIAGNOSTICS_RUN_PERMISSION,
  type ContributorDiagnosticsReport,
  type DiagnosticsAuthorizationOutcome,
  type DiagnosticsOptions
} from "./types.ts";

function checkAuthorization(options: DiagnosticsOptions): DiagnosticsAuthorizationOutcome {
  const actor = options.actor;
  if (!actor || !actor.id) {
    return { allowed: false, reason: "missing_actor" };
  }
  const permissions = actor.permissions ?? [];
  if (!permissions.includes(DIAGNOSTICS_RUN_PERMISSION)) {
    return { allowed: false, reason: "missing_permission" };
  }
  return { allowed: true };
}

function nowIso(options: DiagnosticsOptions): string {
  if (options.now instanceof Date) return options.now.toISOString();
  if (typeof options.now === "number") return new Date(options.now).toISOString();
  return new Date().toISOString();
}

function emptyReport(
  options: DiagnosticsOptions,
  authorization: DiagnosticsAuthorizationOutcome
): ContributorDiagnosticsReport {
  return {
    evaluatedAt: nowIso(options),
    overallStatus: "failing",
    summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
    checks: [],
    remediationSteps: [],
    authorization
  };
}

export async function runDiagnostics(
  options: DiagnosticsOptions = {}
): Promise<ContributorDiagnosticsReport> {
  const auth = checkAuthorization(options);
  if (!auth.allowed) {
    return emptyReport(options, auth);
  }
  const report = await runContributorDiagnostics(options);
  return { ...report, authorization: auth };
}

/** CLI entry point: run diagnostics and print a formatted report. */
export async function runDiagnosticsCli(options: DiagnosticsOptions = {}): Promise<ContributorDiagnosticsReport> {
  const report = await runDiagnostics(options);
  // eslint-disable-next-line no-console
  console.log(formatDiagnosticsReportForCli(report));
  return report;
}

// Imported here to avoid a circular dependency at module load time for tests
// that import only the runner types.
import { formatDiagnosticsReport } from "./runner.ts";

function formatDiagnosticsReportForCli(report: ContributorDiagnosticsReport): string {
  if (report.authorization && !report.authorization.allowed) {
    const reason = report.authorization.reason === "missing_actor"
      ? "No actor supplied. Provide an actor with the 'diagnostics:run' permission."
      : `Actor is missing the '${DIAGNOSTICS_RUN_PERMISSION}' permission.`;
    return [
      "=================================================",
      "       UTIX CONTRIBUTOR DIAGNOSTICS REPORT       ",
      "=================================================",
      `Evaluated at: ${report.evaluatedAt}`,
      "Status: UNAUTHORIZED",
      `Authorization: ${reason}`,
      "================================================="
    ].join("\n");
  }
  return formatDiagnosticsReport(report);
}
