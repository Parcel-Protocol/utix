# Development workflow

This file records the contributor-facing behavior of the development loop and
CI. [CONTRIBUTING.md](./CONTRIBUTING.md) covers how to scaffold a feature; this
file covers what happens after you push.

## Local checks

Run the same gate CI runs before opening a pull request:

```bash
npm run check
```

That runs registry generation, ESLint, the full unit/component suite, feature
and boundary checks, issue validation, telemetry/reconciliation/audit/ledger
verifications, the release gate and a production build.

Additional focused checks used in this repository:

```bash
npm run verify:build-repair   # dry-run repair engine + CLI tests (no dependencies)
npm run verify:ci-concurrency # workflow concurrency guard (no dependencies)
npm run test:e2e:critical     # deterministic account-history journey
```

## CI concurrency

`.github/workflows/ci.yml` declares a workflow-level concurrency group:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

What that means for contributors:

- Each pull request gets its own group, keyed by the workflow name and the PR
  number. Pushing another commit to the same PR cancels only that PR's older,
  still-running CI job. The newest revision gets the runner immediately.
- Different pull requests never cancel each other. Their groups are distinct,
  so unrelated feature slices stay independent.
- Push events (including release validation on `main`) use the branch ref as the
  group and have `cancel-in-progress` disabled. A PR — or another push — cannot
  cancel a release validation run.
- Job names, step names, step order and required status-check names are
  unchanged. Branch protection rules do not need updating.
- A cancelled run is reported as cancelled, not failed. Re-run it from the
  Actions UI if you need its result; no artifacts are published by a cancelled
  run.

The group is evaluated from GitHub Actions expression values, not shell
interpolation, so it is deterministic for a given event and ref. Checkout,
npm cache and the generated-registry guard remain in place.

## Pull requests

Branch off `dev` and open the pull request against `dev` (not `main`). Link the
issue you are closing and describe the decisions you made, not just the files
you touched. The CI check above must pass before review.
