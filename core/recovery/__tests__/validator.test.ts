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
  });
});
