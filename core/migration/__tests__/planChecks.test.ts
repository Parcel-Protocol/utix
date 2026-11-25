/**
 * Release readiness checks for the migration chain and rollback path (#339).
 */

import { describe, expect, it } from 'vitest';
import {
  checkMigrationChain,
  checkMigrationPlan,
  checkMigrationReversibility,
  rehearseMigrations
} from '../plan-checks';
import { MigrationReleaseReadinessVerifier } from '../release-readiness';
import type { MigrationDefinition, MigrationRiskLevel } from '../types';

interface Order {
  id: string;
  amount: number;
  currency?: string;
}

function migration(
  overrides: Partial<MigrationDefinition<Order, Order>> & { id: string; fromVersion: number; toVersion: number }
): MigrationDefinition<Order, Order> {
  const riskLevel: MigrationRiskLevel = overrides.riskLevel ?? 'medium';
  return {
    name: overrides.id,
    description: 'Adds a currency column to orders',
    riskLevel,
    rollbackNotes: 'Drop the currency column; restore from the pre-release snapshot',
    forwardFixNotes: 'Backfill currency with USD through a patch migration',
    dryRun: (records) => ({
      migrationId: overrides.id,
      targetVersion: overrides.toVersion,
      totalRecords: records.length,
      affectedCount: records.length,
      unchangedCount: 0,
      sampleDiffs: [],
      riskLevel,
      rollbackNotes: '',
      forwardFixNotes: '',
      estimatedDurationMs: 1
    }),
    apply: (records) => ({
      transformed: records.map((r) => ({ ...r, currency: 'USD' })),
      affectedCount: records.length
    }),
    rollback: (records) => ({
      transformed: records.map((r) => ({ id: r.id, amount: r.amount })),
      affectedCount: records.length
    }),
    postChecks: [
      {
        name: 'currency_present',
        description: 'Every order has a currency',
        validate: (records) => ({
          checkName: 'currency_present',
          passed: records.every((r) => typeof r.currency === 'string')
        })
      }
    ],
    rollbackChecks: [
      {
        name: 'currency_removed',
        description: 'No order keeps a currency after rollback',
        validate: (records) => ({
          checkName: 'currency_removed',
          passed: records.every((r) => r.currency === undefined)
        })
      }
    ],
    ...overrides
  };
}

const SAMPLE: Order[] = [
  { id: 'o1', amount: 10 },
  { id: 'o2', amount: 25 }
];

describe('migration chain continuity', () => {
  it('accepts a contiguous plan that ends on the target version', () => {
    const plan = [
      migration({ id: 'm3', fromVersion: 2, toVersion: 3 }),
      migration({ id: 'm4', fromVersion: 3, toVersion: 4 })
    ];
    expect(checkMigrationChain(plan, 2, 4)).toEqual([]);
  });

  it('flags a gap, a wrong starting version and a plan that stops short', () => {
    const plan = [
      migration({ id: 'm3', fromVersion: 1, toVersion: 3 }),
      migration({ id: 'm5', fromVersion: 4, toVersion: 5 })
    ];
    const problems = checkMigrationChain(plan, 2, 6);
    expect(problems).toContain('Migration m3 starts at version 1, expected 2');
    expect(problems).toContain('Migration m5 starts at version 4, expected 3');
    expect(problems).toContain('Plan ends at version 5, but the release targets 6');
  });

  it('flags duplicate ids, non-forward steps and downgrade targets', () => {
    const plan = [
      migration({ id: 'dup', fromVersion: 2, toVersion: 3 }),
      migration({ id: 'dup', fromVersion: 3, toVersion: 3 })
    ];
    const problems = checkMigrationChain(plan, 2, 3);
    expect(problems).toContain('Migration id dup appears more than once');
    expect(problems).toContain('Migration dup does not move forward (3 -> 3)');
    expect(checkMigrationChain([], 4, 3)[0]).toMatch(/below the deployed version/);
  });

  it('allows an empty plan only when no version change is needed', () => {
    expect(checkMigrationChain([], 3, 3)).toEqual([]);
    expect(checkMigrationChain([], 3, 4)).toEqual(['No migrations lead from version 3 to 4']);
  });
});

describe('rollback readiness', () => {
  it('requires a rollback handler above low risk', () => {
    const plan = [
      migration({ id: 'low', fromVersion: 1, toVersion: 2, riskLevel: 'low', rollback: undefined }),
      migration({ id: 'medium', fromVersion: 2, toVersion: 3, rollback: undefined })
    ];
    expect(checkMigrationReversibility(plan)).toEqual([
      'Migration medium (medium risk) has no rollback handler'
    ]);
  });

  it('requires rollback verification for high and critical risk', () => {
    const plan = [
      migration({ id: 'high', fromVersion: 1, toVersion: 2, riskLevel: 'high', rollbackChecks: [] }),
      migration({ id: 'critical', fromVersion: 2, toVersion: 3, riskLevel: 'critical', rollbackChecks: undefined })
    ];
    expect(checkMigrationReversibility(plan)).toEqual([
      'Migration high (high risk) has no rollback verification checks',
      'Migration critical (critical risk) has no rollback verification checks'
    ]);
  });
});

describe('rollback rehearsal', () => {
  it('passes when apply and rollback round-trip the sample', async () => {
    const plan = [migration({ id: 'm3', fromVersion: 2, toVersion: 3 })];
    const input = JSON.parse(JSON.stringify(SAMPLE)) as Order[];
    expect(await rehearseMigrations(plan, input)).toEqual([]);
    // The caller's records are never handed to the handlers.
    expect(input).toEqual(SAMPLE);
  });

  it('fails when rollback does not restore the original records', async () => {
    const lossy = migration({
      id: 'lossy',
      fromVersion: 2,
      toVersion: 3,
      rollback: (records) => ({
        transformed: records.map((r) => ({ id: r.id, amount: 0 })),
        affectedCount: records.length
      })
    });
    expect(await rehearseMigrations([lossy], SAMPLE)).toEqual([
      'Rollback of lossy did not restore the pre-migration records'
    ]);
  });

  it('reports failed post-checks and rollback checks', async () => {
    const broken = migration({
      id: 'broken',
      fromVersion: 2,
      toVersion: 3,
      apply: (records) => ({ transformed: records.map((r) => ({ ...r })), affectedCount: 0 }),
      rollbackChecks: [
        {
          name: 'always_fails',
          description: 'fixture',
          validate: async () => ({ checkName: 'always_fails', passed: false })
        }
      ]
    });
    expect(await rehearseMigrations([broken], SAMPLE)).toEqual([
      'Post-check currency_present failed for broken',
      'Rollback check always_fails failed for broken'
    ]);
  });

  it('stops at the first handler that throws', async () => {
    const throwing = migration({
      id: 'throws',
      fromVersion: 2,
      toVersion: 3,
      apply: () => {
        throw new Error('constraint violation');
      }
    });
    const after = migration({ id: 'after', fromVersion: 3, toVersion: 4 });
    expect(await rehearseMigrations([throwing, after], SAMPLE)).toEqual([
      'Rehearsal apply of throws threw: constraint violation'
    ]);
  });
});

describe('evaluateReadiness integration', () => {
  const maintainer = { role: 'maintainer' as const, userId: 'rel-1' };

  it('approves a contiguous, reversible, rehearsed plan', async () => {
    const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(
      {
        releaseId: 'rel_v3',
        targetVersion: 3,
        currentVersion: 2,
        rehearsalRecords: SAMPLE,
        migrations: [migration({ id: 'm3', fromVersion: 2, toVersion: 3 })]
      },
      maintainer
    );
    expect(report.status).toBe('APPROVED');
    const names = report.checks.map((c) => c.checkName);
    expect(names).toContain('migration_chain_continuity');
    expect(names).toContain('migration_rollback_readiness');
    expect(names).toContain('migration_rollback_rehearsal');
  });

  it('rejects a plan that does not reach the target version', async () => {
    const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(
      {
        releaseId: 'rel_v4',
        targetVersion: 4,
        currentVersion: 2,
        migrations: [migration({ id: 'm3', fromVersion: 2, toVersion: 3 })]
      },
      maintainer
    );
    expect(report.status).toBe('REJECTED');
    expect(report.discrepancies).toContain('Plan ends at version 3, but the release targets 4');
  });

  it('leaves existing callers unchanged when currentVersion is omitted', async () => {
    const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(
      {
        releaseId: 'rel_legacy',
        targetVersion: 9,
        migrations: [migration({ id: 'm3', fromVersion: 2, toVersion: 3 })]
      },
      maintainer
    );
    expect(report.status).toBe('APPROVED');
    expect(report.checks.map((c) => c.checkName)).not.toContain('migration_chain_continuity');
  });

  it('still refuses unauthorized actors before running plan checks', async () => {
    const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(
      {
        releaseId: 'rel_v3',
        targetVersion: 3,
        currentVersion: 2,
        rehearsalRecords: SAMPLE,
        migrations: [
          migration({
            id: 'm3',
            fromVersion: 2,
            toVersion: 3,
            apply: () => {
              throw new Error('must not run');
            }
          })
        ]
      },
      { role: 'contributor' }
    );
    expect(report.status).toBe('UNAUTHORIZED');
    expect(report.checks.map((c) => c.checkName)).toEqual(['actor_authorization']);
  });

  it('exposes the plan checks standalone', async () => {
    const report = await checkMigrationPlan([], { currentVersion: 5, targetVersion: 5 });
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(2);
  });
});
