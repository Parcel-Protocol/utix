#!/usr/bin/env node
/**
 * Build repair CLI: dry-run-first repair of a JSON-backed build state file.
 *
 * Usage:
 *   node scripts/build-repair.mjs --plan build-repair.json --state bundle-baseline.json
 *   UTIX_USER_ROLE=maintainer node scripts/build-repair.mjs --plan build-repair.json \
 *     --state bundle-baseline.json --apply --confirm <plan-id>
 *   UTIX_USER_ROLE=maintainer node scripts/build-repair.mjs --plan build-repair.json \
 *     --state bundle-baseline.json --rollback
 *
 * No dependencies are installed or downloaded. Dry run is the default.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_BATCH_SIZE,
  createFileCheckpointStore,
  rollbackRepair,
  runRepair,
  validatePlan
} from "./build-repair/engine.mjs";

const HELP = `
Build repair (dry run by default)

Options:
  --plan <file>         JSON plan: { id, version, steps: [{ id, key, before, after, reversible? }] }
  --state <file>        JSON object holding the build state to repair
  --checkpoint <file>   Checkpoint file (default: <state>.repair-checkpoint.json)
  --apply               Execute the plan instead of previewing it
  --rollback            Restore before-images from the checkpoint journal
  --restart             Start over even if a checkpoint exists (old journal kept in history)
  --confirm <plan-id>   Required with --apply: echo the plan id you reviewed
  --batch-size <n>      Checkpoint every n steps (default: ${DEFAULT_BATCH_SIZE})
  --json                Machine-readable output
  --help                Show this help

Auth: UTIX_USER_ROLE=maintainer (or admin:recovery via the role table) is required
      for --apply and --rollback. UTIX_USER_ID is recorded in the output.
Exit: 0 success, 1 refusal/failure, 2 invalid usage.
`;

function parseArgs(argv) {
  const flags = {
    plan: null,
    state: null,
    checkpoint: null,
    apply: false,
    rollback: false,
    restart: false,
    confirm: null,
    batchSize: DEFAULT_BATCH_SIZE,
    json: false,
    help: false
  };
  const values = new Set(["--plan", "--state", "--checkpoint", "--confirm", "--batch-size"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (values.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      index += 1;
      if (arg === "--plan") flags.plan = value;
      if (arg === "--state") flags.state = value;
      if (arg === "--checkpoint") flags.checkpoint = value;
      if (arg === "--confirm") flags.confirm = value;
      if (arg === "--batch-size") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { error: "--batch-size must be a positive integer" };
        flags.batchSize = parsed;
      }
      continue;
    }
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--rollback") flags.rollback = true;
    else if (arg === "--restart") flags.restart = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else return { error: `unknown option: ${arg}` };
  }
  return { flags };
}

async function readJson(file, label) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function createStateTarget(file, initial) {
  const state = { ...initial };
  return {
    state,
    async read(key) {
      if (!Object.hasOwn(state, key)) throw new Error(`key not found in state: ${key}`);
      return state[key];
    },
    async write(key, value) {
      state[key] = value;
      await atomicWriteJson(file, state);
    }
  };
}

function short(value) {
  const text = JSON.stringify(value ?? null);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function format(result) {
  if (!result.ok) {
    const detail = Object.entries(result.detail ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `  ${key}: ${short(value)}`)
      .join("\n");
    return `repair refused: ${result.code}\n${detail}`;
  }
  const value = result.value;
  if (value.mode === "dry_run") {
    const lines = [`dry run: ${value.changes.length} step(s), 0 write(s), fingerprint ${value.fingerprint.slice(0, 12)}`];
    for (const change of value.changes) {
      lines.push(
        `  ${change.matchesPlan ? "[ok]" : "[drift]"} ${change.id} ${change.key}: ${short(change.before)} -> ${short(change.after)}`
      );
    }
    return lines.join("\n");
  }
  if (Array.isArray(value.rolledBack)) {
    return [
      `rollback ${value.status}: ${value.rolledBack.length} restored, ${value.manual.length} manual, ${value.failed.length} failed`,
      value.manual.length ? `  manual: ${value.manual.join(", ")}` : "",
      value.failed.length ? `  failed: ${value.failed.map((entry) => entry.id).join(", ")}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `applied ${value.applied.length} step(s) (${value.writes} write(s), ${value.resumedAfter ? `resumed after ${value.resumedAfter}` : "fresh run"}), checkpoint revision ${value.checkpointRevision}`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[build-repair] ${parsed.error}\n${HELP}`);
    return 2;
  }
  const flags = parsed.flags;
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (!flags.plan || !flags.state) {
    console.error("[build-repair] --plan and --state are required\n" + HELP);
    return 2;
  }
  if (flags.apply && flags.rollback) {
    console.error("[build-repair] --apply and --rollback are mutually exclusive");
    return 2;
  }
  if (flags.restart && !flags.apply) {
    console.error("[build-repair] --restart must be used with --apply");
    return 2;
  }

  try {
    const plan = await readJson(path.resolve(flags.plan), "plan");
    const invalid = validatePlan(plan);
    if (invalid) {
      console.error(`[build-repair] ${invalid}: the plan must have id, version and 1..5000 steps with before/after images`);
      return 2;
    }
    const statePath = path.resolve(flags.state);
    const initialState = await readJson(statePath, "state");
    const checkpointPath = path.resolve(flags.checkpoint ?? `${statePath}.repair-checkpoint.json`);
    const checkpoints = createFileCheckpointStore(checkpointPath);
    const target = createStateTarget(statePath, initialState);
    const auth = { role: process.env.UTIX_USER_ROLE ?? "viewer", userId: process.env.UTIX_USER_ID };

    if (flags.apply) {
      // Keep the original state. A retry must not overwrite the first backup.
      const backup = `${statePath}.bak`;
      try {
        await fs.copyFile(statePath, backup, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      }
    }

    const result = flags.rollback
      ? await rollbackRepair({ id: plan.id, target, checkpoints, auth })
      : await runRepair({
          plan,
          target,
          checkpoints,
          auth,
          apply: flags.apply,
          confirm: flags.confirm,
          restart: flags.restart,
          batchSize: flags.batchSize
        });

    if (flags.json) {
      console.log(JSON.stringify({ ...result, actor: auth.userId ?? auth.role }, null, 2));
    } else {
      console.log(format(result));
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[build-repair] fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

main().then((code) => process.exit(code));
