/**
 * Dry-run-first repair engine with restartable checkpoints.
 *
 * The engine owns no storage: a `target` supplies async `read(key)` / `write(key, value)`
 * and a `checkpoints` store supplies async `load(id)` / compare-and-set `save(checkpoint, expectedRevision)`.
 * This module deliberately uses only Node built-ins so it can be verified without installing dependencies.
 *
 * Safety model:
 * - A dry run never writes and never touches a checkpoint.
 * - Applying requires maintainer permission and echoing the plan id back as confirmation.
 * - Every applied step is journaled with its before-image; a checkpoint is saved per batch.
 * - A failed run halts at a step boundary. Re-running with the same plan resumes the checkpoint.
 * - A write that landed just before a crash is recognised on resume and journaled without a second write.
 * - Rollback restores before-images newest-first; irreversible steps are reported as manual follow-ups.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export const REPAIR_PERMISSION = "admin:recovery";
export const ENGINE_VERSION = 1;
export const DEFAULT_BATCH_SIZE = 10;
export const MAX_PLAN_STEPS = 5_000;

/** Mirrors core/auth/types.ts: only maintainer holds admin:recovery. Unknown roles fail closed. */
const ROLE_PERMISSIONS = {
  viewer: ["view:tools", "view:dashboard"],
  maintainer: [
    "view:tools",
    "view:dashboard",
    "admin:health",
    "admin:recovery",
    "admin:metrics",
    "admin:replay",
    "admin:config"
  ],
  service: ["admin:health", "admin:metrics"]
};

export function hasPermission(role, permission) {
  return Object.hasOwn(ROLE_PERMISSIONS, role) && ROLE_PERMISSIONS[role].includes(permission);
}

export function mayRepair(auth) {
  return hasPermission(auth?.role, REPAIR_PERMISSION);
}

function ok(value) {
  return { ok: true, value };
}

function fail(code, detail = {}) {
  return { ok: false, code, detail };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value ?? null;
}

function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

export function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function messageOf(error) {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/** SHA-256 over the step identities, before/after images and reversibility flags. */
export function planFingerprint(steps) {
  const material = steps.map((step) => ({
    id: step.id,
    key: step.key,
    before: step.before ?? null,
    after: step.after ?? null,
    reversible: step.reversible !== false
  }));
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

/** Returns an error code for an unsafe/incoherent plan, or null when it is usable. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || typeof plan.id !== "string" || !plan.id) return "repair_invalid_plan";
  if (typeof plan.version !== "string" || !plan.version) return "repair_invalid_plan";
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_PLAN_STEPS) {
    return "repair_invalid_plan";
  }
  const seen = new Set();
  for (const step of plan.steps) {
    if (!step || typeof step !== "object") return "repair_invalid_plan";
    if (typeof step.id !== "string" || !step.id || seen.has(step.id)) return "repair_invalid_plan";
    if (typeof step.key !== "string" || !step.key) return "repair_invalid_plan";
    if (!("after" in step)) return "repair_invalid_plan";
    if (step.reversible !== false && step.before === undefined) return "repair_invalid_plan";
    seen.add(step.id);
  }
  return null;
}

/** In-memory reference store. `save` is a compare-and-set on `revision`. */
export function createMemoryCheckpointStore(seed = []) {
  const entries = new Map(seed.map((checkpoint) => [checkpoint.id, clone(checkpoint)]));
  return {
    async load(id) {
      const checkpoint = entries.get(id);
      return checkpoint ? clone(checkpoint) : null;
    },
    async save(checkpoint, expectedRevision) {
      const current = entries.get(checkpoint.id);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      entries.set(checkpoint.id, clone(checkpoint));
      return true;
    }
  };
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

/** File-backed checkpoint store with the same compare-and-set contract. */
export function createFileCheckpointStore(file) {
  return {
    async load(id) {
      let raw;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      const checkpoint = JSON.parse(raw);
      return checkpoint?.id === id ? checkpoint : null;
    },
    async save(checkpoint, expectedRevision) {
      let current = null;
      try {
        current = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (current && current.id !== checkpoint.id) return false;
      if ((current?.revision ?? null) !== expectedRevision) return false;
      await atomicWriteJson(file, checkpoint);
      return true;
    }
  };
}

function freshCheckpoint(plan, fingerprint, now) {
  return {
    id: plan.id,
    planVersion: plan.version,
    fingerprint,
    engineVersion: ENGINE_VERSION,
    revision: 0,
    status: "in_progress",
    phase: "apply",
    nextIndex: 0,
    journal: [],
    history: [],
    startedAt: now(),
    updatedAt: now()
  };
}

/**
 * Preview or apply a plan. Preview is read-only; apply is maintainer-only and
 * idempotent across crashes and retries.
 */
export async function runRepair(options) {
  const {
    plan,
    target,
    checkpoints = createMemoryCheckpointStore(),
    auth,
    apply = false,
    confirm,
    now = () => new Date().toISOString(),
    batchSize = DEFAULT_BATCH_SIZE,
    restart = false
  } = options;

  const invalid = validatePlan(plan);
  if (invalid) return fail(invalid);
  const fingerprint = planFingerprint(plan.steps);
  if (plan.fingerprint !== undefined && plan.fingerprint !== fingerprint) return fail("repair_plan_tampered");
  if (!Number.isInteger(batchSize) || batchSize < 1) return fail("repair_invalid_batch_size");

  if (!apply) {
    const changes = [];
    for (const step of plan.steps) {
      let before;
      try {
        before = await target.read(step.key);
      } catch (error) {
        return fail("repair_source_unavailable", { at: step.id, message: messageOf(error) });
      }
      changes.push({
        id: step.id,
        key: step.key,
        before: before ?? null,
        after: step.after,
        matchesPlan: step.before === undefined || deepEqual(before, step.before)
      });
    }
    return ok({ mode: "dry_run", changes, fingerprint, writes: 0 });
  }

  if (!mayRepair(auth)) return fail("repair_unauthorized");
  if (confirm !== plan.id) return fail("repair_confirmation_required");

  let checkpoint = await checkpoints.load(plan.id);
  if (checkpoint) {
    if (
      checkpoint.engineVersion !== ENGINE_VERSION ||
      checkpoint.fingerprint !== fingerprint ||
      checkpoint.planVersion !== plan.version
    ) {
      return fail("repair_checkpoint_mismatch");
    }
    if (checkpoint.phase === "rollback" && !restart) return fail("repair_rollback_pending");
    if (checkpoint.status === "completed" && !restart) return fail("repair_already_completed");
    if (checkpoint.status === "rolled_back" && !restart) return fail("repair_checkpoint_rolled_back");
  }

  if (checkpoint && restart) {
    const previous = checkpoint;
    checkpoint = {
      ...previous,
      revision: previous.revision + 1,
      status: "in_progress",
      phase: "apply",
      nextIndex: 0,
      journal: [],
      history: [
        ...(previous.history ?? []),
        {
          revision: previous.revision,
          status: previous.status,
          phase: previous.phase,
          journal: previous.journal
        }
      ].slice(-5),
      updatedAt: now()
    };
    if (!(await checkpoints.save(checkpoint, previous.revision))) return fail("repair_checkpoint_conflict");
  } else if (!checkpoint) {
    checkpoint = freshCheckpoint(plan, fingerprint, now);
    if (!(await checkpoints.save(checkpoint, null))) return fail("repair_checkpoint_conflict");
  }

  const resumedAfter = checkpoint.nextIndex > 0 ? plan.steps[checkpoint.nextIndex - 1].id : null;
  let index = checkpoint.nextIndex;
  let sinceCheckpoint = 0;
  let writes = 0;

  const halt = async (code, detail) => {
    const next = {
      ...checkpoint,
      revision: checkpoint.revision + 1,
      status: "halted",
      phase: "apply",
      updatedAt: now()
    };
    const saved = await checkpoints.save(next, checkpoint.revision);
    if (saved) checkpoint = next;
    return fail(code, { ...detail, checkpointSaved: saved });
  };

  while (index < plan.steps.length) {
    // Claim the batch before writing. A stale checkpoint loses this compare-and-set
    // and stops here, without touching the state file.
    if (sinceCheckpoint === 0) {
      if (!(await checkpoints.save(checkpoint, checkpoint.revision))) {
        return fail("repair_checkpoint_conflict", { at: plan.steps[index].id });
      }
    }

    const step = plan.steps[index];
    const journaled = checkpoint.journal.some((entry) => entry.step.id === step.id);
    let current;
    try {
      current = await target.read(step.key);
    } catch (error) {
      return halt("repair_source_unavailable", { at: step.id, message: messageOf(error) });
    }

    if (deepEqual(current, step.after)) {
      // The write landed but the checkpoint did not: journal it, never write twice.
    } else if (journaled || (step.before !== undefined && deepEqual(current, step.before))) {
      try {
        await target.write(step.key, step.after);
        writes += 1;
      } catch (error) {
        return halt("repair_failed", { at: step.id, message: messageOf(error) });
      }
    } else {
      return halt("repair_state_mismatch", {
        at: step.id,
        before: current ?? null,
        expected: step.before ?? null
      });
    }

    if (!journaled) checkpoint.journal.push({ step, appliedAt: now() });
    index += 1;
    checkpoint.nextIndex = index;
    sinceCheckpoint += 1;

    if (sinceCheckpoint >= batchSize || index === plan.steps.length) {
      const next = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        status: index === plan.steps.length ? "completed" : "in_progress",
        updatedAt: now()
      };
      if (!(await checkpoints.save(next, checkpoint.revision))) {
        return fail("repair_checkpoint_conflict", { at: step.id });
      }
      checkpoint = next;
      sinceCheckpoint = 0;
    }
  }

  return ok({
    mode: "apply",
    completed: true,
    applied: checkpoint.journal.map((entry) => entry.step.id),
    writes,
    resumedAfter,
    checkpointRevision: checkpoint.revision
  });
}

/** Restores before-images newest-first and keeps a resumable journal on failure. */
export async function rollbackRepair(options) {
  const {
    id,
    target,
    checkpoints = createMemoryCheckpointStore(),
    auth,
    now = () => new Date().toISOString()
  } = options;

  if (!mayRepair(auth)) return fail("repair_unauthorized");
  const checkpoint = await checkpoints.load(id);
  if (!checkpoint) return fail("repair_checkpoint_missing");

  const remaining = [...checkpoint.journal];
  const rolledBack = [];
  const manual = [];
  const failed = [];

  for (const entry of [...remaining].reverse()) {
    if (entry.step.reversible === false) {
      manual.push(entry.step.id);
      continue;
    }
    try {
      const current = await target.read(entry.step.key);
      if (!deepEqual(current, entry.step.before ?? null)) {
        await target.write(entry.step.key, entry.step.before ?? null);
      }
      rolledBack.push(entry.step.id);
      remaining.splice(
        remaining.findIndex((candidate) => candidate.step.id === entry.step.id),
        1
      );
    } catch (error) {
      failed.push({ id: entry.step.id, message: messageOf(error) });
    }
  }

  const next = {
    ...checkpoint,
    phase: "rollback",
    status: failed.length ? "halted" : "rolled_back",
    journal: remaining,
    revision: checkpoint.revision + 1,
    updatedAt: now()
  };
  if (!(await checkpoints.save(next, checkpoint.revision))) return fail("repair_checkpoint_conflict");
  return ok({ rolledBack, manual, failed, checkpointRevision: next.revision, status: next.status });
}
