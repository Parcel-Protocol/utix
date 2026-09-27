import { describe, it, expect, beforeEach } from 'vitest';
import { incidentRunbook, registerDefaultProcedures } from '../runbook';

describe('IncidentRunbook', () => {
  beforeEach(() => {
    registerDefaultProcedures();
  });

  it('should create an incident', () => {
    const incident = incidentRunbook.createIncident({
      severity: 'high',
      title: 'Database Connection Loss',
      description: 'Unable to connect to primary database',
      affectedSystems: ['api', 'web'],
    });

    expect(incident.id).toBeDefined();
    expect(incident.severity).toBe('high');
    expect(incident.status).toBe('open');
    expect(incident.timeline.length).toBe(1);
  });

  it('should add mitigation steps', () => {
    const incident = incidentRunbook.createIncident({
      severity: 'high',
      title: 'Test Incident',
      description: 'Test',
      affectedSystems: ['api'],
    });

    incidentRunbook.addMitigationStep(incident.id, {
      action: 'Check database service',
      expectedDuration: 5,
    });

    const updated = incidentRunbook.getIncident(incident.id);
    expect(updated?.mitigationSteps.length).toBe(1);
  });

  it('should update incident status', () => {
    const incident = incidentRunbook.createIncident({
      severity: 'high',
      title: 'Test',
      description: 'Test',
      affectedSystems: ['api'],
    });

    incidentRunbook.updateStatus(incident.id, 'investigating', 'Analyzing logs');

    const updated = incidentRunbook.getIncident(incident.id);
    expect(updated?.status).toBe('investigating');
  });

  it('should get recommended procedures', () => {
    const procedures = incidentRunbook.getRecommendedProcedures(['database_unavailable', 'connection_timeout']);

    expect(procedures.length).toBeGreaterThan(0);
    expect(procedures[0].name).toBe('Database Connection Loss');
  });

  it('should format incident report', () => {
    const incident = incidentRunbook.createIncident({
      severity: 'critical',
      title: 'System Down',
      description: 'Production system is down',
      affectedSystems: ['api', 'web', 'workers'],
    });

    const report = incidentRunbook.formatIncidentReport(incident);
    expect(report).toContain('INCIDENT REPORT');
    expect(report).toContain('System Down');
    expect(report).toContain('CRITICAL');
  });

  describe('serialization, schema validation, and round-trip', () => {
    it('serializes and deserializes incident contexts without losing fields or types', async () => {
      const incident = incidentRunbook.createIncident({
        severity: 'critical',
        title: 'Core DB Partition',
        description: 'Primary database isolated due to network split',
        affectedSystems: ['horizon', 'soroban-rpc']
      });

      incidentRunbook.addMitigationStep(incident.id, {
        action: 'Isolate primary node',
        expectedDuration: 5,
        notes: 'Fencing active'
      });
      await incidentRunbook.completeMitigationStep(incident.id, 1, 'Fence complete');

      incidentRunbook.setRollbackPlan(incident.id, {
        targetVersion: 'v2.4.1',
        estimatedDuration: 15,
        backupLocation: 's3://stellar-ops/backups/db-20260927',
        communicationScript: 'Rollback initiated to restore stability',
        validationSteps: [
          {
            name: 'Verify replica sync',
            rollbackOnFailure: true,
            checkType: 'replication_lag',
            target: 'replica-01',
            expectedOutcome: '< 100ms'
          }
        ]
      });

      // Export incident to versioned envelope
      const exportResult = incidentRunbook.exportIncident(incident.id);
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const envelope = exportResult.value;
      expect(envelope.schemaVersion).toBe('1.0.0');
      expect(typeof envelope.exportedAt).toBe('string');
      expect(new Date(envelope.exportedAt).getTime()).not.toBeNaN();

      // Check serialized properties have ISO timestamps
      expect(typeof envelope.incident.timestamp).toBe('string');
      expect(typeof envelope.incident.timeline[0].timestamp).toBe('string');
      expect(typeof envelope.incident.mitigationSteps[0].completedAt).toBe('string');

      // Re-import into a fresh instance
      const roundTripResult = incidentRunbook.importIncident(envelope);
      expect(roundTripResult.ok).toBe(true);
      if (!roundTripResult.ok) return;

      const restored = roundTripResult.value;
      expect(restored.id).toBe(incident.id);
      expect(restored.timestamp).toBeInstanceOf(Date);
      expect(restored.timestamp.getTime()).toBe(incident.timestamp.getTime());
      expect(restored.severity).toBe('critical');
      expect(restored.status).toBe('open');
      expect(restored.affectedSystems).toEqual(['horizon', 'soroban-rpc']);

      // Timeline preserved
      expect(restored.timeline.length).toBe(incident.timeline.length);
      expect(restored.timeline[0].timestamp).toBeInstanceOf(Date);
      expect(restored.timeline[0].action).toBe('Incident created');

      // Mitigation steps preserved
      expect(restored.mitigationSteps[0].completed).toBe(true);
      expect(restored.mitigationSteps[0].completedAt).toBeInstanceOf(Date);
      expect(restored.mitigationSteps[0].notes).toBe('Fence complete');

      // Rollback plan preserved
      expect(restored.rollbackPlan).toBeDefined();
      expect(restored.rollbackPlan?.targetVersion).toBe('v2.4.1');
      expect(restored.rollbackPlan?.validationSteps).toHaveLength(1);
      expect(restored.rollbackPlan?.validationSteps[0].name).toBe('Verify replica sync');
      expect(restored.rollbackPlan?.validationSteps[0].rollbackOnFailure).toBe(true);
    });

    it('redacts secret material before exporting incident envelopes', () => {
      const secretSeed = 'SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW';
      const incident = incidentRunbook.createIncident({
        severity: 'high',
        title: 'Auth Header Leak Test',
        description: `Leak test with seed ${secretSeed}`,
        affectedSystems: ['auth']
      });

      incidentRunbook.addTimelineEntry(incident.id, {
        action: `Attempted reset using seed ${secretSeed}`,
        actor: 'operator',
        details: {
          secret_key: secretSeed,
          auth_token: 'Bearer eyJhbGciOiJIUzI1NiJ9',
          allowedInfo: 'normal'
        }
      });

      const exportResult = incidentRunbook.exportIncident(incident.id);
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const envelopeStr = JSON.stringify(exportResult.value);
      expect(envelopeStr).not.toContain(secretSeed);
      expect(envelopeStr).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(envelopeStr).toContain('[REDACTED]');
    });

    it('rejects unsupported schema versions', () => {
      const invalid = {
        schemaVersion: '2.0.0', // Unsupported major version
        exportedAt: new Date().toISOString(),
        incident: {
          id: 'inc-1',
          timestamp: new Date().toISOString(),
          severity: 'high',
          status: 'open',
          title: 'Test',
          affectedSystems: [],
          timeline: [],
          mitigationSteps: []
        }
      };

      const result = incidentRunbook.importIncident(invalid);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('unsupported_schema_version');
    });

    it('rejects invalid or corrupted timestamps', () => {
      const invalidTimestamp = {
        schemaVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        incident: {
          id: 'inc-1',
          timestamp: 'not-a-date',
          severity: 'high',
          status: 'open',
          title: 'Corrupted timestamp',
          affectedSystems: [],
          timeline: [],
          mitigationSteps: []
        }
      };

      const result = incidentRunbook.importIncident(invalidTimestamp);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_timestamp');
    });

    it('rejects invalid timeline entries', () => {
      const invalidTimeline = {
        schemaVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        incident: {
          id: 'inc-1',
          timestamp: new Date().toISOString(),
          severity: 'high',
          status: 'open',
          title: 'Bad timeline',
          affectedSystems: [],
          timeline: [
            {
              timestamp: '2026-09-27T10:00:00Z',
              action: '', // Missing action!
              actor: 'operator'
            }
          ],
          mitigationSteps: []
        }
      };

      const result = incidentRunbook.importIncident(invalidTimeline);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_timeline');
    });

    it('rejects invalid mitigation steps or negative durations', () => {
      const invalidMitigation = {
        schemaVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        incident: {
          id: 'inc-1',
          timestamp: new Date().toISOString(),
          severity: 'high',
          status: 'open',
          title: 'Bad mitigation',
          affectedSystems: [],
          timeline: [],
          mitigationSteps: [
            {
              order: 0, // Order must be >= 1
              action: 'Invalid step',
              expectedDuration: -10, // Negative duration
              completed: false
            }
          ]
        }
      };

      const result = incidentRunbook.importIncident(invalidMitigation);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_mitigation_steps');
    });

    it('rejects corrupted rollback plans', () => {
      const invalidRollback = {
        schemaVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        incident: {
          id: 'inc-1',
          timestamp: new Date().toISOString(),
          severity: 'medium',
          status: 'open',
          title: 'Bad rollback',
          affectedSystems: [],
          timeline: [],
          mitigationSteps: [],
          rollbackPlan: {
            targetVersion: 'v1.0.0',
            estimatedDuration: 10,
            backupLocation: 's3://bucket',
            communicationScript: 'script',
            validationSteps: [
              {
                name: '', // Empty name
                rollbackOnFailure: 'yes' // Non-boolean!
              }
            ]
          }
        }
      };

      const result = incidentRunbook.importIncident(invalidRollback);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_rollback_plan');
    });
  });
});
