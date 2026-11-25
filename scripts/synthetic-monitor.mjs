#!/usr/bin/env node

/**
 * Synthetic monitor for the critical journey (#269), the high-value journey
 * catalogue (#368) and the critical-workflow monitor (#410).
 *
 * Runs the live Horizon probes in core/health/. It needs Node 24 (built-in
 * TypeScript type stripping) and the repo's dev dependencies (the loader).
 *
 * Usage:
 *   UTIX_USER_ROLE=service node scripts/synthetic-monitor.mjs [--network testnet|mainnet] [--json]
 *       The #269 critical journey (operation history), exactly as before.
 *   ... --journey <operation-history|account-balances|transaction-lookup|fee-stats>
 *       One journey from the catalogue.
 *   ... --journey all [--state <file>]
 *       Every journey as one workflow, with alerting. With --state the alert
 *       state is read from and written back to <file>, so consecutive runs
 *       open an alert only after 2 failures in a row; without it, every run
 *       starts fresh and one failure is enough to alert.
 *
 * Exit codes: 0 healthy or degraded, 1 unhealthy, 2 unauthorized, bad
 * arguments or crashed.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

const { runSyntheticMonitor } = await import("../core/health/synthetic.ts");
const { runJourney, isJourneyId, JOURNEY_IDS } = await import("../core/health/journeys.ts");
const { createWorkflowMonitor } = await import("../core/health/workflow-monitor.ts");
const { isStellarNetwork } = await import("../core/network/types.ts");

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const network = flag("--network") ?? "testnet";
const journey = flag("--journey");
const statePath = flag("--state");
const json = args.includes("--json");
const auth = { role: process.env.UTIX_USER_ROLE ?? "viewer" };

if (!isStellarNetwork(network)) {
  console.error(`Unknown network "${network}". Use testnet or mainnet.`);
  process.exit(2);
}
if (journey !== undefined && journey !== "all" && !isJourneyId(journey)) {
  console.error(`Unknown journey "${journey}". Use all or one of: ${JOURNEY_IDS.join(", ")}.`);
  process.exit(2);
}
if (statePath !== undefined && journey !== "all") {
  console.error("--state only applies to --journey all.");
  process.exit(2);
}

function refused() {
  console.error("Synthetic monitor refused: the role needs admin:health (set UTIX_USER_ROLE=service).");
  process.exit(2);
}

function printJourney(report, title = `Journey ${report.journey ?? "operation-history"}`) {
  console.log(`${title} on ${report.network}: ${report.status.toUpperCase()} in ${report.durationMs}ms`);
  for (const step of report.steps) {
    const mark = step.skipped ? "-" : step.ok ? "✓" : "✗";
    const failure = step.errorCode ? ` — ${step.errorCode}` : "";
    console.log(`  ${mark} ${step.step} (${step.attempts} attempt(s), ${step.latencyMs}ms)${failure}`);
  }
  if (report.ingestLagLedgers !== undefined) console.log(`  ingestion lag: ${report.ingestLagLedgers} ledger(s)`);
  console.log(`  correlation id: ${report.correlationId}`);
}

/** Reads saved workflow state. An unreadable file is reported and ignored: starting fresh can only delay an alert. */
function loadState(monitor) {
  if (!statePath || !existsSync(statePath)) return;
  try {
    const imported = monitor.importState(JSON.parse(readFileSync(statePath, "utf8")));
    if (!imported.ok) console.error(`Ignoring ${statePath}: ${imported.code}. Starting with fresh alert state.`);
  } catch (error) {
    console.error(`Ignoring unreadable ${statePath} (${error.message}). Starting with fresh alert state.`);
  }
}

/** Writes state atomically (temp file + rename), so a crash never leaves half a file. */
function saveState(monitor) {
  if (!statePath) return;
  const temp = `${statePath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(monitor.state(), null, 2)}\n`);
  renameSync(temp, statePath);
}

try {
  if (journey === "all") {
    const monitor = createWorkflowMonitor(statePath ? {} : { failureThreshold: 1 });
    loadState(monitor);
    const outcome = await monitor.run(auth, { network });
    if (!outcome.ok) refused();
    saveState(monitor);

    const report = outcome.value;
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Critical workflows on ${report.network}: ${report.status.toUpperCase()} in ${report.durationMs}ms`);
      for (const result of report.journeys) {
        const alert = result.alerting ? " [ALERTING]" : "";
        const availability = Math.round((report.availability[result.journey] ?? 1) * 100);
        console.log(`  ${result.critical ? "*" : " "} ${result.journey}: ${result.status}${alert} (${availability}% of recent runs passed)`);
      }
      for (const alert of report.alerts) {
        console.log(`  alert ${alert.transition}: ${alert.journey}${alert.errorCode ? ` (${alert.errorCode})` : ""}`);
      }
      console.log("  * critical journey");
      console.log(`  correlation id: ${report.correlationId}`);
    }
    process.exit(report.status === "unhealthy" ? 1 : 0);
  }

  const outcome = journey === undefined
    ? await runSyntheticMonitor(auth, { network })
    : await runJourney(auth, journey, { network });
  if (!outcome.ok) refused();

  const report = outcome.value;
  if (json) console.log(JSON.stringify(report, null, 2));
  else printJourney(report, journey === undefined ? "Critical journey" : undefined);
  process.exit(report.status === "unhealthy" ? 1 : 0);
} catch (error) {
  console.error("Synthetic monitor crashed:", error);
  process.exit(2);
}
