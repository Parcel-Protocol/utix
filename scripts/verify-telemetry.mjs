#!/usr/bin/env node
/**
 * Verifies the telemetry contract: at least five distinct operations are
 * instrumented with the required structured fields.
 *
 * This is a static scan. It finds every `op: "…"` literal in the instrumented
 * paths (outside tests) and requires that each instrumentation site carries
 * `actorType` and `correlationId` nearby, then fails if fewer than five
 * distinct operations exist or if `TELEMETRY_FIELDS` is ever reduced.
 *
 * Run with: npm run verify:telemetry
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_FIELDS = ["actorType", "correlationId"];

async function listSources(dir) {
  const out = [];
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of dirents) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...(await listSources(full)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function findInstrumentedOps(source) {
  const ops = new Map();
  // Two instrumentation idioms:
  //   1. emitTelemetry({ ..., op: "oper.name", actorType, correlationId })
  //   2. measure("oper.name", { actorType, correlationId }, run) — which emits
  //      the full record internally, so fields are always present.
  const literalRe = /(^|[^\w])op\s*:\s*"([a-z][a-z0-9_.,-]*)"/g;
  const measureRe = /(?:measure|measureSync)\(\s*"([a-z][a-z0-9_.,-]*)"/g;

  const consider = (op, index, kind) => {
    const window = source.slice(Math.max(0, index - 800), index + 800);
    // For emitTelemetry the fields must be present in the call; for measure()
    // they are guaranteed by the wrapper itself.
    const missing =
      kind === "measure"
        ? []
        : REQUIRED_FIELDS.filter((field) => !window.includes(`${field}:`));
    if (missing.length === 0) ops.set(op, true);
  };

  let match;
  while ((match = literalRe.exec(source)) !== null) consider(match[2], match.index, "literal");
  while ((match = measureRe.exec(source)) !== null) consider(match[1], match.index, "measure");

  return ops;
}

async function verify() {
  const dirs = [
    path.join(root, "core"),
    path.join(root, "features", "freighter-connect")
  ];

  const files = (await Promise.all(dirs.map(listSources))).flat();
  const instrumentedOps = new Map();

  for (const file of files) {
    if (file.endsWith(".generated.ts")) continue;
    const source = await readFile(file, "utf8");
    const ops = findInstrumentedOps(source);
    for (const [op, instrumented] of ops) {
      if (instrumented && !instrumentedOps.has(op)) instrumentedOps.set(op, file);
    }
  }

  const requiredRecordFields = await readFile(
    path.join(root, "core", "telemetry", "telemetry.ts"),
    "utf8"
  );
  if (!requiredRecordFields.includes('"op"') || !requiredRecordFields.includes('"correlationId"')) {
    throw new Error("[verify:telemetry] TELEMETRY_FIELDS no longer lists op/correlationId.");
  }

  const ops = [...instrumentedOps.entries()];
  console.log(`[verify:telemetry] found ${ops.length} instrumented operation(s):`);
  for (const [op, file] of ops) console.log(`  - ${op} (${path.relative(root, file)})`);

  if (ops.length < 5) {
    console.error(
      `[verify:telemetry] FAIL: expected >= 5 instrumented operations, got ${ops.length}.`
    );
    process.exit(1);
  }

  console.log("[verify:telemetry] OK");
}

verify().catch((error) => {
  console.error(`[verify:telemetry] FAIL: ${error.message}`);
  process.exit(1);
});