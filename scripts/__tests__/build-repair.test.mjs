import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  createMemoryCheckpointStore,
  runRepair,
  rollbackRepair
} from "../build-repair/engine.mjs";

const MAINTAINER = { role: "maintainer", userId: "ada" };
const VIEWER = { role: "viewer", userId: "visitor" };

function makePlan(overrides = {}) {
  return {
    id: "build-baseline-2026-11",
    version: "1",
    steps: [
      { id: "s1", key: "a", before: 1, after: 10 },
      { id: "s2", key: "b", before: 2, after: 20 },
      { id: "s3", key: "c", before: 3, after: 30 }
    ],
    ...overrides
  };
}

function makeTarget(initial = { a: 1, b: 2, c: 3 }, hooks = {}) {
  const state = { ...initial };
  const writes = [];
  return {
    state,
    writes,
    async read(key) {
      if (hooks.readError?.has(key)) throw new Error(`read failed: ${key}`);
      if (!Object.hasOwn(state, key)) throw new Error(`unknown key: ${key}`);
      return state[key];
    },
    async write(key, value) {
      if (hooks.writeError?.has(key)) throw new Error(`write failed: ${key}`);
      state[key] = value;
      writes.push(key);
    }
  };
}

describe("dry run", () => {
  test("previews every step without writing or checkpointing", async () => {
    const plan = makePlan();
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();

    const result = await runRepair({ plan, target, checkpoints, auth: VIEWER });

    assert.equal(result.ok, true);
    assert.equal(result.value.mode, "dry_run");
    assert.equal(result.value.changes.length, 3);
    assert.equal(result.value.writes, 0);
    assert.deepEqual(target.state, { a: 1, b: 2, c: 3 });
    assert.equal(await checkpoints.load(plan.id), null);
    assert.deepEqual(result.value.changes[0], {
      id: "s1",
      key: "a",
      before: 1,
      after: 10,
      matchesPlan: true
    });
  });

  test("reports drift between the plan's before image and the live state", async () => {
    const result = await runRepair({
      plan: makePlan(),
      target: makeTarget({ a: 99, b: 2, c: 3 }),
      auth: VIEWER
    });
    assert.equal(result.value.changes[0].matchesPlan, false);
  });

  test("fails loudly when a read is unavailable", async () => {
    const result = await runRepair({
      plan: makePlan(),
      target: makeTarget({ a: 1, b: 2, c: 3 }, { readError: new Set(["b"]) }),
      auth: VIEWER
    });
    assert.deepEqual([result.ok, result.code], [false, "repair_source_unavailable"]);
    assert.equal(result.detail.at, "s2");
  });
});

describe("apply", () => {
  test("checkpoints per batch, is idempotent, and refuses an accidental second run", async () => {
    const plan = makePlan();
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();

    const first = await runRepair({
      plan,
      target,
      checkpoints,
      auth: MAINTAINER,
      apply: true,
      confirm: plan.id,
      batchSize: 2
    });
    assert.equal(first.ok, true);
    assert.deepEqual(target.state, { a: 10, b: 20, c: 30 });
    assert.deepEqual(target.writes, ["a", "b", "c"]);
    assert.equal(first.value.writes, 3);
    const checkpoint = await checkpoints.load(plan.id);
    assert.equal(checkpoint.status, "completed");
    assert.equal(checkpoint.phase, "apply");
    assert.equal(checkpoint.nextIndex, 3);
    assert.equal(checkpoint.revision, 2); // initial + 2 batches

    const duplicate = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(duplicate.code, "repair_already_completed");

    const restarted = await runRepair({
      plan,
      target,
      checkpoints,
      auth: MAINTAINER,
      apply: true,
      confirm: plan.id,
      restart: true
    });
    assert.equal(restarted.ok, true);
    assert.equal(restarted.value.writes, 0); // already at `after`
    assert.equal((await checkpoints.load(plan.id)).history.length, 1);
  });

  test("halts on a write failure and resumes from the last checkpoint", async () => {
    const plan = makePlan();
    const hooks = { writeError: new Set(["b"]) };
    const target = makeTarget({ a: 1, b: 2, c: 3 }, hooks);
    const checkpoints = createMemoryCheckpointStore();

    const failed = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.deepEqual([failed.ok, failed.code], [false, "repair_failed"]);
    assert.equal(failed.detail.at, "s2");
    let checkpoint = await checkpoints.load(plan.id);
    assert.equal(checkpoint.status, "halted");
    assert.equal(checkpoint.nextIndex, 1);
    assert.equal(checkpoint.journal.length, 1);
    assert.deepEqual(target.state, { a: 10, b: 2, c: 3 });

    hooks.writeError.clear();
    const retried = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(retried.ok, true);
    assert.equal(retried.value.resumedAfter, "s1");
    assert.deepEqual(target.state, { a: 10, b: 20, c: 30 });
    checkpoint = await checkpoints.load(plan.id);
    assert.equal(checkpoint.status, "completed");
    assert.equal(checkpoint.journal.length, 3);
  });

  test("journals a write that landed before the checkpoint without writing it twice", async () => {
    const plan = makePlan();
    const hooks = { writeError: new Set(["b"]) };
    const target = makeTarget({ a: 1, b: 2, c: 3 }, hooks);
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    // Simulate the crash window: b was written, but its checkpoint was never saved.
    hooks.writeError.clear();
    target.state.b = 20;
    const writesBefore = [...target.writes];
    const resumed = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    assert.equal(resumed.ok, true);
    assert.deepEqual(target.writes.slice(writesBefore.length), ["c"]);
    assert.equal(resumed.value.writes, 1);
    assert.equal((await checkpoints.load(plan.id)).journal.length, 3);
  });

  test("refuses to overwrite state that moved unexpectedly", async () => {
    const plan = makePlan();
    const target = makeTarget({ a: 1, b: 2, c: 3 }, { writeError: new Set(["b"]) });
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    target.state.b = 777;
    const result = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(result.code, "repair_state_mismatch");
    assert.deepEqual(target.writes, ["a"]);
  });

  test("refuses a plan that moved since its checkpoint", async () => {
    const plan = makePlan();
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    const result = await runRepair({
      plan: makePlan({ version: "2" }),
      target,
      checkpoints,
      auth: MAINTAINER,
      apply: true,
      confirm: plan.id
    });
    assert.equal(result.code, "repair_checkpoint_mismatch");
  });

  test("refuses when another operator wins the checkpoint compare-and-set", async () => {
    const plan = makePlan();
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();
    let saves = 0;
    checkpoints.save = async () => {
      saves += 1;
      return saves === 1;
    };

    const result = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(result.code, "repair_checkpoint_conflict");
    assert.deepEqual(target.writes, []); // no batch committed
  });
});

describe("authorization", () => {
  test("apply fails closed for viewer, service and unknown roles", async () => {
    for (const role of ["viewer", "service", "someone-else"]) {
      const result = await runRepair({
        plan: makePlan(),
        target: makeTarget(),
        auth: { role },
        apply: true,
        confirm: "build-baseline-2026-11"
      });
      assert.equal(result.code, "repair_unauthorized", role);
    }
  });

  test("requires the reviewed plan id as confirmation", async () => {
    const result = await runRepair({
      plan: makePlan(),
      target: makeTarget(),
      auth: MAINTAINER,
      apply: true,
      confirm: "some-other-plan"
    });
    assert.equal(result.code, "repair_confirmation_required");
  });

  test("refuses a plan whose steps no longer match its fingerprint", async () => {
    const plan = makePlan({ fingerprint: "deadbeef" });
    const result = await runRepair({ plan, target: makeTarget(), auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(result.code, "repair_plan_tampered");
  });

  test("rollback requires maintainer permission too", async () => {
    const result = await rollbackRepair({ id: "anything", target: makeTarget(), auth: VIEWER });
    assert.equal(result.code, "repair_unauthorized");
  });
});

describe("rollback", () => {
  test("restores before-images newest-first and keeps irreversible steps as manual follow-ups", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", key: "a", before: 1, after: 10 },
        { id: "s2", key: "b", before: 2, after: 20, reversible: false },
        { id: "s3", key: "c", before: 3, after: 30 }
      ]
    });
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    const result = await rollbackRepair({ id: plan.id, target, checkpoints, auth: MAINTAINER });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.rolledBack, ["s3", "s1"]);
    assert.deepEqual(result.value.manual, ["s2"]);
    assert.deepEqual(target.state, { a: 1, b: 20, c: 3 });
    assert.equal((await checkpoints.load(plan.id)).status, "rolled_back");
  });

  test("keeps failed restores journaled so rollback can be retried", async () => {
    const plan = makePlan();
    const hooks = { writeError: new Set(["b"]) };
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });

    const failed = await rollbackRepair({ id: plan.id, target: { ...target, write: async (key) => {
      if (hooks.writeError.has(key)) throw new Error("restore failed");
      target.state[key] = plan.steps.find((step) => step.key === key).before;
    } }, checkpoints, auth: MAINTAINER });
    assert.equal(failed.ok, true);
    assert.equal(failed.value.status, "halted");
    assert.deepEqual(failed.value.failed.map((entry) => entry.id), ["s2"]);
    assert.equal((await checkpoints.load(plan.id)).journal.length, 1);

    const retried = await rollbackRepair({ id: plan.id, target, checkpoints, auth: MAINTAINER });
    assert.equal(retried.value.status, "rolled_back");
    assert.deepEqual(target.state, { a: 1, b: 2, c: 3 });
  });

  test("refuses to apply while a rollback is pending", async () => {
    const plan = makePlan();
    const target = makeTarget();
    const checkpoints = createMemoryCheckpointStore();
    await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    await rollbackRepair({ id: plan.id, target, checkpoints, auth: MAINTAINER });

    const result = await runRepair({ plan, target, checkpoints, auth: MAINTAINER, apply: true, confirm: plan.id });
    assert.equal(result.code, "repair_rollback_pending");

    const restarted = await runRepair({
      plan,
      target,
      checkpoints,
      auth: MAINTAINER,
      apply: true,
      confirm: plan.id,
      restart: true
    });
    assert.equal(restarted.ok, true);
    assert.deepEqual(target.state, { a: 10, b: 20, c: 30 });
  });
});

describe("CLI executable verification", () => {
  const cli = fileURLToPath(new URL("../build-repair.mjs", import.meta.url));

  function runCli(args, role = "viewer") {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, UTIX_USER_ROLE: role },
      encoding: "utf8"
    });
  }

  test("dry run, maintainer apply, and rollback all work end to end", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utix-build-repair-"));
    const planFile = path.join(dir, "plan.json");
    const stateFile = path.join(dir, "state.json");
    const checkpointFile = path.join(dir, "checkpoint.json");
    const plan = makePlan();
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(stateFile, JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2));
    const args = ["--plan", planFile, "--state", stateFile, "--checkpoint", checkpointFile];

    try {
      const preview = runCli(args);
      assert.equal(preview.status, 0, preview.stderr);
      assert.match(preview.stdout, /dry run: 3 step\(s\), 0 write\(s\)/);
      assert.equal(fs.existsSync(checkpointFile), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { a: 1, b: 2, c: 3 });

      const denied = runCli([...args, "--apply", "--confirm", plan.id], "viewer");
      assert.equal(denied.status, 1);
      assert.match(denied.stdout, /repair_unauthorized/);

      const missingConfirm = runCli([...args, "--apply"], "maintainer");
      assert.equal(missingConfirm.status, 1);
      assert.match(missingConfirm.stdout, /repair_confirmation_required/);

      const applied = runCli([...args, "--apply", "--confirm", plan.id], "maintainer");
      assert.equal(applied.status, 0, applied.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { a: 10, b: 20, c: 30 });
      assert.equal(JSON.parse(fs.readFileSync(checkpointFile, "utf8")).status, "completed");
      assert.equal(fs.existsSync(`${stateFile}.bak`), true);

      const rolledBack = runCli([...args, "--rollback"], "maintainer");
      assert.equal(rolledBack.status, 0, rolledBack.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { a: 1, b: 2, c: 3 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the original backup when a failed apply is retried", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utix-build-repair-"));
    const planFile = path.join(dir, "plan.json");
    const stateFile = path.join(dir, "state.json");
    const checkpointFile = path.join(dir, "checkpoint.json");
    const plan = {
      id: "retry-backup",
      version: "1",
      steps: [
        { id: "s1", key: "a", before: 1, after: 10 },
        { id: "s2", key: "b", before: 2, after: 20 }
      ]
    };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(stateFile, JSON.stringify({ a: 1 }, null, 2));
    const args = ["--plan", planFile, "--state", stateFile, "--checkpoint", checkpointFile];

    try {
      const failed = runCli([...args, "--apply", "--confirm", plan.id], "maintainer");
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, /repair_source_unavailable/);
      assert.deepEqual(JSON.parse(fs.readFileSync(`${stateFile}.bak`, "utf8")), { a: 1 });

      // Operator fixes the source, then re-runs the same command.
      fs.writeFileSync(stateFile, JSON.stringify({ a: 10, b: 2 }, null, 2));
      const retried = runCli([...args, "--apply", "--confirm", plan.id], "maintainer");
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { a: 10, b: 20 });
      assert.deepEqual(JSON.parse(fs.readFileSync(`${stateFile}.bak`, "utf8")), { a: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
