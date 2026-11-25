#!/usr/bin/env node
/**
 * Contributor Diagnostics CLI Tool (#460 / #275 / #416)
 *
 * Validates the contributor development environment:
 * - Node.js version >= v20
 * - Package and dependency integrity
 * - Sanitized environment variables and zero secret keys
 * - Feature registry synchronization
 * - Feature boundary isolation
 *
 * Supports normal, failure, retry, and authorization paths:
 *   node scripts/contributor-diagnostics.mjs
 *   node scripts/contributor-diagnostics.mjs --json
 *   node scripts/contributor-diagnostics.mjs --strict
 *   node scripts/contributor-diagnostics.mjs --actor dev-1 --permission diagnostics:run
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runContributorDiagnostics, formatDiagnosticsReport } from "../core/diagnostics/runner.ts";
import { runDiagnostics } from "../core/diagnostics/diagnostics.ts";
import { DIAGNOSTICS_RUN_PERMISSION } from "../core/diagnostics/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const isJson = process.argv.includes("--json");
  const isStrict = process.argv.includes("--strict");
  const enforceAuth = process.argv.includes("--enforce-auth") || process.argv.includes("--actor");

  let actor;
  const actorIdx = process.argv.indexOf("--actor");
  if (actorIdx !== -1 && process.argv[actorIdx + 1]) {
    const actorId = process.argv[actorIdx + 1];
    const permissions = process.argv.includes("--no-permission")
      ? []
      : [DIAGNOSTICS_RUN_PERMISSION];
    actor = { kind: "contributor", id: actorId, permissions };
  } else if (!enforceAuth) {
    // Default local contributor actor
    actor = { kind: "contributor", id: "local-contributor", permissions: [DIAGNOSTICS_RUN_PERMISSION] };
  }

  try {
    let report;
    if (enforceAuth || actor) {
      report = await runDiagnostics({
        projectRoot: root,
        strict: isStrict,
        actor
      });
    } else {
      report = await runContributorDiagnostics({
        projectRoot: root,
        strict: isStrict
      });
    }

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDiagnosticsReport(report));
    }

    if (report.overallStatus === "failing" || (report.authorization && !report.authorization.allowed)) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("[contributor-diagnostics] Unexpected fatal error:");
    console.error(err);
    process.exit(2);
  }
}

main();

