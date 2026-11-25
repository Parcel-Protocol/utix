import { beforeEach, describe, expect, it } from 'vitest';
import { incidentRunbook, registerDefaultProcedures } from '../runbook';
import { getAuditTrail } from '@/core/audit/audit';
import type { RollbackPlan } from '../types';

describe('Incident Runbook Executable Recovery Checks (Issue #369)', () => {
  const operatorActor = { kind: 'operator' as const, id: 'ops-engineer-42' };
  const maintainerActor = { kind: 'maintainer' as const, id: 'maintainer-root' };
  const userActor = { kind: 'user' as const, id: 'unauthorized-client' };

  beforeEach(() => {
    incidentRunbook.reset();
    registerDefaultProcedures();
    getAuditTrail().reset();
  });

  describe('Normal Path: End-to-End Recovery Check Verification', () => {
    it('executes validation checks, verifies 100% pass, and transitions status to mitigated', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'critical',
        title: 'Horizon Gateway Latency Spike',
        description: 'P99 latency exceeding 2000ms on primary RPC',
        affectedSystems: ['horizon-client', 'balance-viewer']
      });

      const plan: RollbackPlan = {
        targetVersion: 'v1.4.2-stable',
        estimatedDuration: 10,
        backupLocation: 's3://backups/horizon-config.json',
        communicationScript: 'Failover to secondary cluster complete.',
        validationSteps: [
          {
            name: 'Check secondary Horizon endpoint HTTP 200',
            target: 'horizon-secondary',
            rollbackOnFailure: true,
            check: async () => true
          },
          {
            name: 'Verify balance viewer read response < 100ms',
            target: 'balance-viewer',
            rollbackOnFailure: true,
            check: async () => true
          }
        ]
      };

      incidentRunbook.setRollbackPlan(incident.id, plan);

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: operatorActor
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.passed).toBe(true);
      expect(result.value.status).toBe('passed');
      expect(result.value.executedChecks).toHaveLength(2);
      expect(result.value.executedChecks.every(c => c.passed)).toBe(true);
      expect(result.value.rollbackTriggered).toBe(false);
      expect(result.value.auditReceipt).toHaveLength(64);

      // Verify incident state mutation
      const updatedIncident = incidentRunbook.getIncident(incident.id);
      expect(updatedIncident?.status).toBe('mitigated');
      expect(updatedIncident?.timeline.some(t => t.action.includes('Automated recovery verification passed'))).toBe(true);

      // Verify audit record
      const auditTrail = getAuditTrail().all();
      expect(auditTrail.some(a => a.action === 'incident.recovery_verified')).toBe(true);
    });
  });

  describe('Failure Path: Failing Validation Step Triggers Rollback', () => {
    it('halts execution on critical check failure and marks status as investigating', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'high',
        title: 'Stale Ledger Monotonicity Breach',
        description: 'Sequence numbers out of sync',
        affectedSystems: ['sequence-inspector']
      });

      const plan: RollbackPlan = {
        targetVersion: 'v1.0.0',
        estimatedDuration: 5,
        backupLocation: 's3://backups/seq.json',
        communicationScript: 'Rolled back.',
        validationSteps: [
          {
            name: 'Failing ledger sequence check',
            target: 'sequence-inspector',
            rollbackOnFailure: true,
            check: async () => false // FAILS
          },
          {
            name: 'Downstream check that should not run',
            target: 'sequence-inspector',
            rollbackOnFailure: false,
            check: async () => true
          }
        ]
      };

      incidentRunbook.setRollbackPlan(incident.id, plan);

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: operatorActor,
        abortOnFirstFailure: true
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe('rollback_execution_failed');

      const updated = incidentRunbook.getIncident(incident.id);
      expect(updated?.status).toBe('investigating');
      expect(updated?.timeline.some(t => t.action.includes('Recovery check failed: Failing ledger sequence check'))).toBe(true);
    });
  });

  describe('Retry Path: Transient Check Failure with Backoff', () => {
    it('retries transient check failure up to maxRetries and passes', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'medium',
        title: 'Transient RPC Network Glitch',
        description: 'Occasional connection drop',
        affectedSystems: ['horizon-client']
      });

      let attempts = 0;
      const plan: RollbackPlan = {
        targetVersion: 'v1.0.0',
        estimatedDuration: 5,
        backupLocation: 's3://backups/net.json',
        communicationScript: 'Stabilized.',
        validationSteps: [
          {
            name: 'Flaky network health check',
            target: 'horizon-client',
            rollbackOnFailure: true,
            check: async () => {
              attempts += 1;
              return attempts >= 2; // Fails on attempt 1, passes on attempt 2
            }
          }
        ]
      };

      incidentRunbook.setRollbackPlan(incident.id, plan);

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: operatorActor,
        maxRetries: 3,
        retryBackoffMs: 5
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.passed).toBe(true);
      expect(result.value.executedChecks[0].attempts).toBe(2);
    });
  });

  describe('Authorization Path: Operator Role Enforcement', () => {
    it('rejects unauthorized client/user actor from executing recovery checks', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'low',
        title: 'Minor UI Refresh Bug',
        description: 'Cache inconsistency',
        affectedSystems: ['ui']
      });

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: userActor
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe('unauthorized_operator');
    });

    it('allows maintainer actor to execute recovery checks', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'low',
        title: 'Maintainer Guided Recovery',
        description: 'Manual recovery inspection',
        affectedSystems: ['admin']
      });

      const plan: RollbackPlan = {
        targetVersion: 'v1.0.0',
        estimatedDuration: 1,
        backupLocation: 's3://backup',
        communicationScript: 'Verified.',
        validationSteps: [
          {
            name: 'Maintainer check',
            rollbackOnFailure: false,
            check: async () => true
          }
        ]
      };
      incidentRunbook.setRollbackPlan(incident.id, plan);

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: maintainerActor
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('Fallback Check Discovery', () => {
    it('discovers checks from recommended procedures when rollbackPlan has no validation steps', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'critical',
        title: 'Database connection drop',
        description: 'Auto triage test',
        affectedSystems: ['database_unavailable']
      });

      const result = await incidentRunbook.executeRecoveryChecks(incident.id, {
        actor: operatorActor
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.executedChecks.length).toBeGreaterThan(0);
    });
  });
});

