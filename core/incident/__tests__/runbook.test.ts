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
});
