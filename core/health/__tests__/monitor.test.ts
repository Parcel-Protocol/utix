import { describe, it, expect } from 'vitest';
import { healthMonitor, formatHealthReport } from '../monitor';
import { HealthSummary } from '../types';

describe('Health monitor', () => {
  describe('checkHealth', () => {
    it('returns health summary with all components', async () => {
      const summary = await healthMonitor.checkHealth();
      
      expect(summary.timestamp).toBeInstanceOf(Date);
      expect(summary.overallStatus).toMatch(/^(healthy|degraded|unhealthy)$/);
      expect(Array.isArray(summary.indicators)).toBe(true);
      expect(Array.isArray(summary.unresolvedExceptions)).toBe(true);
      expect(Array.isArray(summary.staleRecords)).toBe(true);
      expect(summary.metrics).toBeDefined();
    });

    it('includes feature registry health check', async () => {
      const summary = await healthMonitor.checkHealth();
      
      const registryIndicator = summary.indicators.find(
        i => i.name === 'Feature Registry'
      );
      
      expect(registryIndicator).toBeDefined();
      expect(registryIndicator?.status).toBeDefined();
      expect(registryIndicator?.message).toBeTruthy();
      expect(registryIndicator?.lastChecked).toBeInstanceOf(Date);
    });

    it('includes network connectivity checks', async () => {
      const summary = await healthMonitor.checkHealth();
      
      const networkIndicators = summary.indicators.filter(
        i => i.name.startsWith('Network:')
      );
      
      expect(networkIndicators.length).toBeGreaterThan(0);
    });

    it('includes environment configuration check', async () => {
      const summary = await healthMonitor.checkHealth();
      
      const envIndicator = summary.indicators.find(
        i => i.name === 'Environment Configuration'
      );
      
      expect(envIndicator).toBeDefined();
    });

    it('computes correct metrics', async () => {
      const summary = await healthMonitor.checkHealth();
      
      expect(summary.metrics.totalFeatures).toBeGreaterThanOrEqual(0);
      expect(summary.metrics.healthyFeatures).toBeLessThanOrEqual(summary.metrics.totalFeatures);
      expect(summary.metrics.unresolvedExceptionCount).toBe(summary.unresolvedExceptions.length);
      expect(summary.metrics.staleRecordCount).toBe(summary.staleRecords.length);
    });
  });

  describe('recordException', () => {
    it('records unresolved exceptions', () => {
      healthMonitor.recordException({
        type: 'TestError',
        message: 'Test exception',
        context: { key: 'value' },
      });
      
      const exceptions = healthMonitor.getUnresolvedExceptions();
      const testException = exceptions.find(e => e.type === 'TestError');
      
      expect(testException).toBeDefined();
      expect(testException?.message).toBe('Test exception');
      expect(testException?.resolved).toBe(false);
    });
  });

  describe('recordStaleRecord', () => {
    it('records stale records with computed age', () => {
      const lastActivity = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);
      
      healthMonitor.recordStaleRecord({
        id: 'test-record',
        type: 'TestType',
        lastActivity,
        details: { key: 'value' },
      });
      
      const staleRecords = healthMonitor.getStaleRecords(0);
      const testRecord = staleRecords.find(r => r.id === 'test-record');
      
      expect(testRecord).toBeDefined();
      expect(testRecord?.age).toBeGreaterThan(0);
    });

    it('filters stale records by max age', () => {
      const recentActivity = new Date(Date.now() - 1000 * 60);
      const oldActivity = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);
      
      healthMonitor.recordStaleRecord({
        id: 'recent',
        type: 'Test',
        lastActivity: recentActivity,
        details: {},
      });
      
      healthMonitor.recordStaleRecord({
        id: 'old',
        type: 'Test',
        lastActivity: oldActivity,
        details: {},
      });
      
      const maxAge = 1000 * 60 * 60 * 24;
      const oldRecords = healthMonitor.getStaleRecords(maxAge);
      
      expect(oldRecords.some(r => r.id === 'old')).toBe(true);
      expect(oldRecords.some(r => r.id === 'recent')).toBe(false);
    });
  });

  describe('formatHealthReport', () => {
    it('formats healthy system report', () => {
      const summary: HealthSummary = {
        timestamp: new Date('2026-01-01T00:00:00Z'),
        overallStatus: 'healthy',
        indicators: [
          {
            name: 'Test Indicator',
            status: 'healthy',
            message: 'All good',
            lastChecked: new Date(),
          },
        ],
        unresolvedExceptions: [],
        staleRecords: [],
        metrics: {
          totalFeatures: 10,
          healthyFeatures: 10,
          unresolvedExceptionCount: 0,
          staleRecordCount: 0,
        },
      };
      
      const report = formatHealthReport(summary);
      
      expect(report).toContain('OPERATIONAL HEALTH DASHBOARD');
      expect(report).toContain('HEALTHY');
      expect(report).toContain('10/10 healthy');
      expect(report).toContain('✓ Test Indicator: All good');
    });

    it('includes exceptions in report', () => {
      const summary: HealthSummary = {
        timestamp: new Date(),
        overallStatus: 'degraded',
        indicators: [],
        unresolvedExceptions: [
          {
            id: 'exc-123',
            timestamp: new Date(),
            type: 'TestError',
            message: 'Something broke',
            resolved: false,
          },
        ],
        staleRecords: [],
        metrics: {
          totalFeatures: 10,
          healthyFeatures: 9,
          unresolvedExceptionCount: 1,
          staleRecordCount: 0,
        },
      };
      
      const report = formatHealthReport(summary);
      
      expect(report).toContain('UNRESOLVED EXCEPTIONS');
      expect(report).toContain('TestError');
      expect(report).toContain('Something broke');
    });

    it('includes stale records in report', () => {
      const summary: HealthSummary = {
        timestamp: new Date(),
        overallStatus: 'degraded',
        indicators: [],
        unresolvedExceptions: [],
        staleRecords: [
          {
            id: 'stale-123',
            type: 'StaleType',
            age: 1000 * 60 * 60 * 24 * 7,
            lastActivity: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7),
            details: {},
          },
        ],
        metrics: {
          totalFeatures: 10,
          healthyFeatures: 10,
          unresolvedExceptionCount: 0,
          staleRecordCount: 1,
        },
      };
      
      const report = formatHealthReport(summary);
      
      expect(report).toContain('STALE RECORDS');
      expect(report).toContain('StaleType');
      expect(report).toContain('7 days old');
    });
  });
});
