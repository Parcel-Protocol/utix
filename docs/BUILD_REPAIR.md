# Build repair: dry runs with checkpoints

`scripts/build-repair.mjs` is a small operator tool for repairing a JSON-backed
build state file (for example a generated budget baseline or a local build
manifest). It is deliberately generic: the engine in
`scripts/build-repair/engine.mjs` knows nothing about the file it repairs, and
uses only Node built-ins so it can be run and tested without installing
dependencies.

The tool follows the same safety shape as the rest of Utix's operator tooling:
preview first, apply only with an explicit confirmation, checkpoint each batch,
resume after failure, and keep before-images for rollback.

## Plan and state

A plan is a JSON object:

```json
{
  "id": "build-baseline-2026-11",
  "version": "1",
  "steps": [
    {
      "id": "warning-threshold",
      "key": "warningMb",
      "before": 512,
      "after": 640
    },
    {
      "id": "legacy-flag",
      "key": "legacyAdapter",
      "before": true,
      "after": false,
      "reversible": false
    }
  ]
}
```

- `id` is the stable run identity and the checkpoint key.
- `version` must be bumped when the steps change; a checkpoint from another
  version is refused.
- `before` is required for reversible steps and is what rollback restores.
  Set `"reversible": false` for a terminal move (it is skipped by rollback and
  reported as a manual follow-up).
- `key` addresses a top-level property of the state file, which must be a JSON
  object. `after` is the value to write.
- An optional `fingerprint` field is checked against a SHA-256 of the steps, so
  an edited plan cannot be applied under an approved id.

The state file is a plain JSON object, e.g. `{"warningMb": 512,
"legacyAdapter": true}`.

## Running it

```sh
# 1. Preview. Reads every step, writes nothing, creates no checkpoint.
node scripts/build-repair.mjs --plan build-repair.json --state bundle-baseline.json

# 2. Apply. Same command plus --apply and the reviewed plan id.
UTIX_USER_ROLE=maintainer node scripts/build-repair.mjs \
  --plan build-repair.json --state bundle-baseline.json \
  --apply --confirm build-baseline-2026-11

# 3. If a step failed, fix the cause and run the exact same apply command.
#    It resumes from the last checkpoint instead of starting over.

# 4. Undo reversible steps.
UTIX_USER_ROLE=maintainer node scripts/build-repair.mjs \
  --plan build-repair.json --state bundle-baseline.json --rollback
```

Options: `--checkpoint <file>` (default `<state>.repair-checkpoint.json`),
`--batch-size N` (default 10), `--restart` (with `--apply`: start over, keeping
the old journal in `history`), `--json`, `--help`.

`UTIX_USER_ROLE` must be `maintainer` for `--apply` or `--rollback`; dry runs are
read-only and need no role. `UTIX_USER_ID` is included in JSON output for trace
purposes. Exit codes: `0` success, `1` refusal or halted repair, `2` invalid
usage or malformed input. Before the first write the CLI copies the state file
to `<state>.bak`.

## Engine contract

A caller supplies a target (`read(key)`, `write(key, value)`) and a checkpoint
store (`load(id)`, `save(checkpoint, expectedRevision)`). `save` is a
compare-and-set: two operators racing on one checkpoint produce
`repair_checkpoint_conflict` for the loser. The in-memory reference store and
the CLI's file store implement the same contract.

`runRepair({ plan, target, checkpoints, auth, apply, confirm, batchSize, restart })`
returns a `Result`: `{ ok: true, value }` or `{ ok: false, code, detail }`.
`rollbackRepair({ id, target, checkpoints, auth })` has the same shape.

A checkpoint records:

| Field | Meaning |
| --- | --- |
| `revision` | Compare-and-set revision; incremented on every save |
| `status` | `in_progress`, `halted`, `completed` or `rolled_back` |
| `phase` | `apply` or `rollback` — prevents applying while an undo is pending |
| `nextIndex` | First step that still needs to run |
| `journal` | Applied steps with their before-images, newest last |
| `fingerprint` / `planVersion` / `engineVersion` | Guard against a changed plan or engine |
| `history` | Previous journals kept by `--restart` (last five) |

## Safety properties

- **Dry run is the default.** It reads the live state, shows each before/after
  pair and flags drift against the plan's `before`; it never writes and never
  loads a checkpoint.
- **Explicit confirmation.** Apply must echo the plan `id`. Unknown roles,
  `viewer` and `service` fail closed with `repair_unauthorized`.
- **Stale state is refused.** A step whose live value is neither its `before`
  nor its `after` stops the run with `repair_state_mismatch`; no other step is
  written. This is what prevents overwriting a change made after the preview.
- **One operator at a time.** A batch is claimed with a compare-and-set before
  its first write, so a stale checkpoint loses before touching the state file.
- **Crash-safe resume.** A checkpoint is saved before the first write and after
  every batch. If a write landed but its checkpoint did not, the next run sees
  the `after` value, journals the step and skips the duplicate write.
- **Failure budget by batch.** The run stops at the failing step with status
  `halted`; the journal and checkpoint remain for inspection and retry.
- **Rollback is resumable.** Before-images are restored newest-first. Failed
  restores stay in the journal so `--rollback` can be run again. A pending
  rollback blocks a new apply.
- **No external writes.** The engine imports only `node:crypto` and `node:fs`;
  no network, no dependency download, no secret handling.

## Edge cases and failure modes

| Situation | Code / status | What to do |
| --- | --- | --- |
| Unknown key or unreadable state file | `repair_source_unavailable` / fatal `2` | Fix the file or the plan's `key`; no writes happened |
| Live value differs from `before` | `repair_state_mismatch` | Re-preview against the new state; do not force it |
| Target write throws | `repair_failed`, checkpoint `halted` | Fix the target, re-run the same apply command |
| Another operator saved first | `repair_checkpoint_conflict` | Let them finish, then re-run; no batch was committed by the loser |
| Plan edited after review | `repair_plan_tampered` | Re-preview and confirm the new plan id |
| Plan version changed | `repair_checkpoint_mismatch` | Use `--restart` deliberately, or migrate the checkpoint |
| Run already completed | `repair_already_completed` | Nothing to do; `--restart` rescans (and writes nothing if already at `after`) |
| Checkpoint lost or corrupt | `repair_checkpoint_missing` / `repair_checkpoint_conflict` | Restore from `<state>.bak`, then re-run; or `--restart` with a fresh backup |
| Rollback of an irreversible step | listed in `manual` | Follow the step's own recovery instructions; no automatic undo exists |
| Rollback write fails | `status: halted`, journal retained | Fix the cause and run `--rollback` again |
| Crash between write and checkpoint | resumed as already applied | Nothing to do; re-run the same command |

## Recovery and rollback

1. **Automatic on failure:** no automatic rollback is attempted during apply —
   the journal is kept so a human can inspect the partial state. A resume is
   normally preferable to a rollback because it completes the same plan.
2. **Undo a completed apply:** run `--rollback` with a maintainer role. It
   restores each reversible step's `before` value and marks the checkpoint
   `rolled_back`. Irreversible steps are returned in `manual`.
3. **Last resort:** `<state>.bak` is the copy taken before the first write. Use
   it when the checkpoint itself is lost or corrupt. Any changes made to the
   state file after the repair will also be lost, so inspect before restoring.
4. **Restart:** `--restart` archives the old checkpoint in `history` and scans
   from step one. Earlier journals are then available only for manual recovery.

## Compatibility

This is an additive tool. No existing API, workflow, schema or user-facing
behavior changes, and the CLI does not touch the state file unless `--apply`,
`--restart` or `--rollback` is passed. Existing `npm run check`, required CI
check names and feature contracts are untouched. No migration is needed.

## Verification

```bash
npm run verify:build-repair    # node:test: dry run, apply, failure, retry,
                               # authorization, conflict, rollback, CLI e2e
```

The tests use temporary directories and injected targets; they do not require
`node_modules`, Playwright or network access.
