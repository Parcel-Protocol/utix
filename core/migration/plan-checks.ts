/**
 * Release readiness checks for the migration chain and its rollback path (#339).
 *
 * `MigrationReleaseReadinessVerifier.evaluateReadiness` checks each migration's
 * documentation and risk in isolation. These checks look at the plan as a
 * whole and at whether it can actually be undone:
 *
 * - `chain`        — migrations form one contiguous path from the deployed
 *                    version to the release's target version, with no gaps,
 *                    overlaps, downgrades or duplicate ids.
 * - `reversible`   — every migration above `low` risk ships a `rollback`
 *                    handler, and every `high`/`critical` one also ships at
 *                    least one `rollbackCheck` to prove the restore worked.
 * - `rehearsal`    — optional: runs dry-run → apply → post-checks → rollback
 *                    → rollback checks on a copy of sample records, and fails
 *                    when the round trip does not restore the original data.
 *
 * All checks are pure with respect to the caller's data: sample records are
 * deep-copied before any handler sees them. See docs/RELEASE_READINESS_GATE.md.
 */

import type { ReadinessCheckResult } from './release-readiness';
import type { MigrationDefinition, PostMigrationCheckResult } from './types';

export interface MigrationPlanOptions {
  /** Schema version currently deployed. */
  readonly currentVersion: number;
  /** Version the release must end on. */
  readonly targetVersion: number;
  /**
   * When set, each migration is rehearsed on a deep copy of these records. The
   * records are treated as input to the first migration and chained through.
   */
  readonly rehearsalRecords?: readonly unknown[];
}

export interface MigrationPlanCheckReport {
  readonly passed: boolean;
  readonly checks: readonly ReadinessCheckResult[];
  readonly discrepancies: readonly string[];
}

// Migrations in one plan transform different record shapes, and the handler
// properties are contravariant, so `unknown` would reject every typed plan.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMigration = MigrationDefinition<any, any>;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Contiguity of the plan from `currentVersion` to `targetVersion`. */
export function checkMigrationChain(
  migrations: readonly AnyMigration[],
  currentVersion: number,
  targetVersion: number
): string[] {
  const problems: string[] = [];
  if (targetVersion < currentVersion) {
    problems.push(
      `Target version ${targetVersion} is below the deployed version ${currentVersion}; ship a forward migration instead of a downgrade`
    );
  }
  if (migrations.length === 0) {
    if (targetVersion !== currentVersion) {
      problems.push(`No migrations lead from version ${currentVersion} to ${targetVersion}`);
    }
    return problems;
  }

  const seen = new Set<string>();
  let expectedFrom = currentVersion;
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      problems.push(`Migration id ${migration.id} appears more than once`);
    }
    seen.add(migration.id);

    if (migration.toVersion <= migration.fromVersion) {
      problems.push(
        `Migration ${migration.id} does not move forward (${migration.fromVersion} -> ${migration.toVersion})`
      );
    }
    if (migration.fromVersion !== expectedFrom) {
      problems.push(
        `Migration ${migration.id} starts at version ${migration.fromVersion}, expected ${expectedFrom}`
      );
    }
    expectedFrom = migration.toVersion;
  }

  if (expectedFrom !== targetVersion) {
    problems.push(`Plan ends at version ${expectedFrom}, but the release targets ${targetVersion}`);
  }
  return problems;
}

/** Whether each migration can be undone and the undo verified. */
export function checkMigrationReversibility(migrations: readonly AnyMigration[]): string[] {
  const problems: string[] = [];
  for (const migration of migrations) {
    if (migration.riskLevel === 'low') continue;
    if (typeof migration.rollback !== 'function') {
      problems.push(
        `Migration ${migration.id} (${migration.riskLevel} risk) has no rollback handler`
      );
      continue;
    }
    const needsVerification = migration.riskLevel === 'high' || migration.riskLevel === 'critical';
    if (needsVerification && (migration.rollbackChecks?.length ?? 0) === 0) {
      problems.push(
        `Migration ${migration.id} (${migration.riskLevel} risk) has no rollback verification checks`
      );
    }
  }
  return problems;
}

async function runChecks(
  results: Promise<PostMigrationCheckResult>[]
): Promise<PostMigrationCheckResult[]> {
  return Promise.all(results);
}

/**
 * Rehearses each migration on a copy of `records`, chaining outputs. Returns
 * problems found; an empty list means every step applied, passed its
 * post-checks and rolled back to an identical copy of its input.
 */
export async function rehearseMigrations(
  migrations: readonly AnyMigration[],
  records: readonly unknown[]
): Promise<string[]> {
  const problems: string[] = [];
  let input: unknown[] = copy([...records]);

  for (const migration of migrations) {
    const before = copy(input);
    try {
      migration.dryRun(copy(input), { dryRun: true });
    } catch (error) {
      problems.push(`Dry run of ${migration.id} threw: ${message(error)}`);
      return problems;
    }

    let output: unknown[];
    try {
      output = migration.apply(copy(input)).transformed;
    } catch (error) {
      problems.push(`Rehearsal apply of ${migration.id} threw: ${message(error)}`);
      return problems;
    }

    let postResults: PostMigrationCheckResult[];
    try {
      postResults = await runChecks(
        migration.postChecks.map((check) => Promise.resolve(check.validate(output)))
      );
    } catch (error) {
      problems.push(`Post-checks of ${migration.id} threw: ${message(error)}`);
      return problems;
    }
    for (const result of postResults) {
      if (!result.passed) {
        problems.push(`Post-check ${result.checkName} failed for ${migration.id}`);
      }
    }

    if (typeof migration.rollback === 'function') {
      let restored: unknown[];
      try {
        restored = migration.rollback(copy(output)).transformed;
      } catch (error) {
        problems.push(`Rehearsal rollback of ${migration.id} threw: ${message(error)}`);
        return problems;
      }
      if (JSON.stringify(restored) !== JSON.stringify(before)) {
        problems.push(`Rollback of ${migration.id} did not restore the pre-migration records`);
      }
      try {
        const rollbackResults = await runChecks(
          (migration.rollbackChecks ?? []).map((check) =>
            Promise.resolve(check.validate(restored, before))
          )
        );
        for (const result of rollbackResults) {
          if (!result.passed) {
            problems.push(`Rollback check ${result.checkName} failed for ${migration.id}`);
          }
        }
      } catch (error) {
        problems.push(`Rollback checks of ${migration.id} threw: ${message(error)}`);
      }
    }

    input = output;
  }
  return problems;
}

/** Runs every plan-level check and returns them in readiness-report form. */
export async function checkMigrationPlan(
  migrations: readonly AnyMigration[],
  options: MigrationPlanOptions
): Promise<MigrationPlanCheckReport> {
  const checks: ReadinessCheckResult[] = [];
  const discrepancies: string[] = [];

  const record = (checkName: string, problems: string[], okMessage: string): void => {
    checks.push({
      checkName,
      passed: problems.length === 0,
      message: problems.length === 0 ? okMessage : problems.join('; ')
    });
    discrepancies.push(...problems);
  };

  record(
    'migration_chain_continuity',
    checkMigrationChain(migrations, options.currentVersion, options.targetVersion),
    `Plan moves contiguously from version ${options.currentVersion} to ${options.targetVersion}`
  );
  record(
    'migration_rollback_readiness',
    checkMigrationReversibility(migrations),
    'Every migration above low risk can be rolled back'
  );
  if (options.rehearsalRecords !== undefined) {
    record(
      'migration_rollback_rehearsal',
      await rehearseMigrations(migrations, options.rehearsalRecords),
      `Rehearsed ${migrations.length} migration(s) forward and back on ${options.rehearsalRecords.length} record(s)`
    );
  }

  return { passed: discrepancies.length === 0, checks, discrepancies };
}
