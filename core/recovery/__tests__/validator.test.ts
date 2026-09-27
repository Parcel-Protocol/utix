import { describe, it, expect, beforeEach } from 'vitest';
import { validator, formatValidationReport } from '../validator';
import { InvariantViolation } from '../types';

describe('Recovery validator', () => {
  describe('validate', () => {
    it('runs all registered checks', async () => {
      const result = await validator.validate();
      
      expect(result).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.checks.total).toBeGreaterThan(0);
    });

    it('reports passed when no violations found', async () => {
      const result = await validator.validate();
      
      if (result.violations.length === 0) {
        expect(result.passed).toBe(true);
        expect(result.checks.passed).toBe(result.checks.total);
        expect(result.checks.failed).toBe(0);
      }
    });

    it('includes violation details when checks fail', async () => {
      const result = await validator.validate();
      
      result.violations.forEach(violation => {
        expect(violation.type).toBeDefined();
        expect(violation.severity).toMatch(/^(critical|warning)$/);
        expect(violation.message).toBeTruthy();
        expect(violation.details).toBeDefined();
        expect(Array.isArray(violation.affectedRecords)).toBe(true);
      });
    });
  });

  describe('formatValidationReport', () => {
    it('formats passed validation report', () => {
      const result = {
        timestamp: new Date('2026-01-01T00:00:00Z'),
        passed: true,
        violations: [],
        checks: { total: 5, passed: 5, failed: 0 },
      };
      
      const report = formatValidationReport(result);
      
      expect(report).toContain('PASSED');
      expect(report).toContain('5 passed, 0 failed, 5 total');
      expect(report).toContain('All invariants validated successfully');
    });

    it('formats failed validation report with violations', () => {
      const violations: InvariantViolation[] = [
        {
          type: 'missing-record',
          severity: 'critical',
          message: 'Test violation',
          details: { key: 'value' },
          affectedRecords: ['record1'],
        },
        {
          type: 'inconsistent-state',
          severity: 'warning',
          message: 'Test warning',
          details: {},
          affectedRecords: [],
        },
      ];
      
      const result = {
        timestamp: new Date('2026-01-01T00:00:00Z'),
        passed: false,
        violations,
        checks: { total: 5, passed: 3, failed: 2 },
      };
      
      const report = formatValidationReport(result);
      
      expect(report).toContain('FAILED');
      expect(report).toContain('3 passed, 2 failed, 5 total');
      expect(report).toContain('CRITICAL');
      expect(report).toContain('WARNINGS');
      expect(report).toContain('Test violation');
      expect(report).toContain('Test warning');
    });
  });

  describe('registered checks', () => {
    it('includes registry manifest consistency check', async () => {
      const checks = validator.getRegisteredChecks();
      const registryCheck = checks.find(c => c.name === 'registry-manifest-consistency');
      
      expect(registryCheck).toBeDefined();
      expect(registryCheck?.description).toBeTruthy();
    });

    it('includes network configuration validity check', async () => {
      const checks = validator.getRegisteredChecks();
      const networkCheck = checks.find(c => c.name === 'network-configuration-validity');
      
      expect(networkCheck).toBeDefined();
      expect(networkCheck?.description).toBeTruthy();
    });

    it('all checks are executable', async () => {
      const checks = validator.getRegisteredChecks();
      
      for (const check of checks) {
        const violations = await check.check();
        expect(Array.isArray(violations)).toBe(true);
      }
    });

    it('includes clock-skew-and-expiry-boundaries check', async () => {
      const checks = validator.getRegisteredChecks();
      const clockCheck = checks.find(c => c.name === 'clock-skew-and-expiry-boundaries');
      
      expect(clockCheck).toBeDefined();
      expect(clockCheck?.description).toBeTruthy();
    });
  });

  describe('clock-skew and timezone boundary validation', () => {
    const fixedNow = new Date('2026-09-27T12:00:00.000Z');
    const clock = () => fixedNow;

    it('accepts a valid restore manifest within clock skew tolerance', async () => {
      const manifest = {
        restoreId: 'restore-valid',
        backupTimestamp: new Date('2026-09-27T11:50:00.000Z'),
        restoredAt: new Date('2026-09-27T11:55:00.000Z'),
        records: [
          {
            id: 'rec-1',
            createdAt: new Date('2026-09-27T11:40:00.000Z'),
            expiresAt: new Date('2026-09-27T12:30:00.000Z'),
          }
        ]
      };

      const result = await validator.validate({ now: clock, toleranceMs: 60_000, manifests: [manifest] });
      const clockViolations = result.violations.filter(v => v.type === 'clock-skew' || v.type === 'negative-elapsed-time');
      expect(clockViolations).toHaveLength(0);
    });

    it('flags future clocks that exceed skew tolerance', async () => {
      const futureTime = new Date(fixedNow.getTime() + 120_000); // 2 minutes in future
      const manifest = {
        restoreId: 'restore-future',
        backupTimestamp: futureTime,
        restoredAt: new Date(fixedNow.getTime() + 130_000),
        records: []
      };

      const result = await validator.validate({ now: clock, toleranceMs: 60_000, manifests: [manifest] });
      const skewViolations = result.violations.filter(v => v.type === 'clock-skew');
      expect(skewViolations.length).toBeGreaterThanOrEqual(1);
      expect(skewViolations[0].severity).toBe('critical');
      expect(skewViolations[0].message).toContain('future beyond acceptable clock tolerance');
    });

    it('tolerates small future drift within tolerance window', async () => {
      const slightFuture = new Date(fixedNow.getTime() + 30_000); // 30 seconds into future (< 60s tolerance)
      const manifest = {
        restoreId: 'restore-slight-drift',
        backupTimestamp: slightFuture,
        restoredAt: new Date(fixedNow.getTime() + 40_000),
        records: []
      };

      const result = await validator.validate({ now: clock, toleranceMs: 60_000, manifests: [manifest] });
      const skewViolations = result.violations.filter(v => v.type === 'clock-skew');
      expect(skewViolations).toHaveLength(0);
    });

    it('flags negative elapsed time when restore timestamp precedes backup timestamp', async () => {
      const manifest = {
        restoreId: 'restore-negative-elapsed',
        backupTimestamp: '2026-09-27T11:50:00.000Z',
        restoredAt: '2026-09-27T11:40:00.000Z', // 10 minutes earlier than backup!
        records: []
      };

      const result = await validator.validate({ now: clock, manifests: [manifest] });
      const negativeElapsed = result.violations.find(v => v.type === 'negative-elapsed-time');
      expect(negativeElapsed).toBeDefined();
      expect(negativeElapsed?.severity).toBe('critical');
      expect(negativeElapsed?.message).toContain('is earlier than backup timestamp');
    });

    it('normalizes UTC offsets consistently across different timezones', async () => {
      // 10:00 UTC represented with different offsets:
      // +02:00 -> 12:00
      // -05:00 -> 05:00
      const manifest = {
        restoreId: 'restore-tz-offsets',
        backupTimestamp: '2026-09-27T12:00:00+02:00', // 10:00:00 UTC
        restoredAt: '2026-09-27T06:00:00-05:00',      // 11:00:00 UTC (1 hour later)
        records: [
          {
            id: 'rec-tz',
            createdAt: '2026-09-27T04:30:00-05:00',  // 09:30:00 UTC (before backup)
            expiresAt: '2026-09-27T15:00:00+03:00'   // 12:00:00 UTC
          }
        ]
      };

      const result = await validator.validate({ now: clock, manifests: [manifest] });
      const timeViolations = result.violations.filter(v => v.type === 'negative-elapsed-time' || v.type === 'clock-skew');
      expect(timeViolations).toHaveLength(0);
    });

    it('prevents a backwards-moving client clock from reviving expired records (DST/skew defense)', async () => {
      // Scenario: Item expired at 11:30:00 UTC.
      // High-water mark was 11:45:00 UTC (record was observed expired).
      // Now, client clock moved backwards (e.g. DST jump or manual adjustment) to 11:00:00 UTC.
      // Naive `now < expiresAt` would think it is still valid, but conservative recovery rejects it!
      const manifest = {
        restoreId: 'restore-dst-rewind',
        backupTimestamp: '2026-09-27T10:00:00.000Z',
        restoredAt: '2026-09-27T10:15:00.000Z',
        records: [
          {
            id: 'rec-expired-rewound',
            createdAt: '2026-09-27T09:00:00.000Z',
            expiresAt: '2026-09-27T11:30:00.000Z',
            maxObservedTime: '2026-09-27T11:45:00.000Z', // Time previously observed past expiry
          }
        ]
      };

      const rewindClock = () => new Date('2026-09-27T11:00:00.000Z'); // Clock rewound prior to expiry
      const result = await validator.validate({ now: rewindClock, manifests: [manifest] });

      const expiredViolations = result.violations.filter(v => v.type === 'expired-record');
      expect(expiredViolations.length).toBeGreaterThanOrEqual(1);
      expect(expiredViolations[0].severity).toBe('critical');
      expect(expiredViolations[0].message).toContain('backwards client clock cannot revive expired data');
    });

    it('rejects records that were already expired at backup time', async () => {
      const manifest = {
        restoreId: 'restore-pre-expired',
        backupTimestamp: '2026-09-27T11:00:00.000Z',
        restoredAt: '2026-09-27T11:15:00.000Z',
        records: [
          {
            id: 'rec-dead-before-backup',
            createdAt: '2026-09-27T08:00:00.000Z',
            expiresAt: '2026-09-27T10:00:00.000Z', // Expired 1 hour before backup!
          }
        ]
      };

      const result = await validator.validate({ now: clock, manifests: [manifest] });
      const expiredViolations = result.violations.filter(v => v.type === 'expired-record');
      expect(expiredViolations.length).toBeGreaterThanOrEqual(1);
      expect(expiredViolations[0].severity).toBe('critical');
      expect(expiredViolations[0].message).toContain('already expired at backup time and cannot be restored');
    });
  });
});

