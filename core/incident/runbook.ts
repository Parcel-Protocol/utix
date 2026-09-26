import { IncidentContext, IncidentSeverity, IncidentStatus, MitigationStep, RunbookProcedure, TimelineEntry } from './types';

class IncidentRunbook {
  private incidents: Map<string, IncidentContext> = new Map();
  private procedures: Map<string, RunbookProcedure> = new Map();

  createIncident(params: {
    severity: IncidentSeverity;
    title: string;
    description: string;
    affectedSystems: string[];
  }): IncidentContext {
    const incident: IncidentContext = {
      id: `incident-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      severity: params.severity,
      status: 'open',
      title: params.title,
      description: params.description,
      affectedSystems: params.affectedSystems,
      timeline: [],
      mitigationSteps: [],
    };

    this.incidents.set(incident.id, incident);
    this.addTimelineEntry(incident.id, {
      timestamp: new Date(),
      action: 'Incident created',
      actor: 'system',
    });

    return incident;
  }

  addTimelineEntry(incidentId: string, entry: Omit<TimelineEntry, 'timestamp'>): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    incident.timeline.push({
      timestamp: new Date(),
      ...entry,
    });
  }

  addMitigationStep(incidentId: string, step: Omit<MitigationStep, 'completed' | 'order'>): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    const order = (incident.mitigationSteps.length || 0) + 1;
    incident.mitigationSteps.push({
      ...step,
      order,
      completed: false,
    });
  }

  async completeMitigationStep(incidentId: string, stepOrder: number, notes?: string): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    const step = incident.mitigationSteps.find(s => s.order === stepOrder);
    if (!step) throw new Error(`Step ${stepOrder} not found`);

    step.completed = true;
    step.completedAt = new Date();
    step.notes = notes;

    this.addTimelineEntry(incidentId, {
      action: `Mitigation step ${stepOrder} completed: ${step.action}`,
      actor: 'operator',
      details: { notes },
    });
  }

  updateStatus(incidentId: string, status: IncidentStatus, reason: string): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    incident.status = status;
    this.addTimelineEntry(incidentId, {
      action: `Status changed to ${status}`,
      actor: 'operator',
      details: { reason },
    });
  }

  registerProcedure(procedure: RunbookProcedure): void {
    this.procedures.set(procedure.name, procedure);
  }

  getProcedure(name: string): RunbookProcedure | undefined {
    return this.procedures.get(name);
  }

  getRecommendedProcedures(symptoms: string[]): RunbookProcedure[] {
    const recommended: RunbookProcedure[] = [];

    for (const procedure of this.procedures.values()) {
      const matchCount = symptoms.filter(s => procedure.triggers.includes(s)).length;
      if (matchCount > 0) {
        recommended.push(procedure);
      }
    }

    return recommended.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  getIncident(id: string): IncidentContext | undefined {
    return this.incidents.get(id);
  }

  getAllIncidents(): IncidentContext[] {
    return Array.from(this.incidents.values());
  }

  getOpenIncidents(): IncidentContext[] {
    return this.getAllIncidents().filter(i => i.status !== 'resolved');
  }

  formatIncidentReport(incident: IncidentContext): string {
    const lines: string[] = [];

    lines.push('='.repeat(70));
    lines.push('INCIDENT REPORT');
    lines.push('='.repeat(70));
    lines.push('');
    lines.push(`ID: ${incident.id}`);
    lines.push(`Title: ${incident.title}`);
    lines.push(`Severity: ${incident.severity.toUpperCase()}`);
    lines.push(`Status: ${incident.status.toUpperCase()}`);
    lines.push(`Created: ${incident.timestamp.toISOString()}`);
    lines.push('');

    lines.push(`Description: ${incident.description}`);
    lines.push('');

    lines.push(`Affected Systems: ${incident.affectedSystems.join(', ')}`);
    lines.push('');

    if (incident.timeline.length > 0) {
      lines.push('TIMELINE:');
      incident.timeline.forEach((entry, i) => {
        lines.push(`  ${i + 1}. [${entry.timestamp.toISOString()}] ${entry.action} (by ${entry.actor})`);
      });
      lines.push('');
    }

    if (incident.mitigationSteps.length > 0) {
      lines.push('MITIGATION STEPS:');
      incident.mitigationSteps.forEach(step => {
        const status = step.completed ? '✓' : '○';
        lines.push(`  ${status} ${step.order}. ${step.action} (${step.expectedDuration}m)`);
        if (step.notes) lines.push(`     Notes: ${step.notes}`);
      });
      lines.push('');
    }

    if (incident.rollbackPlan) {
      lines.push('ROLLBACK PLAN:');
      lines.push(`  Target Version: ${incident.rollbackPlan.targetVersion}`);
      lines.push(`  Estimated Duration: ${incident.rollbackPlan.estimatedDuration}m`);
      lines.push(`  Backup Location: ${incident.rollbackPlan.backupLocation}`);
      lines.push('');
    }

    lines.push('='.repeat(70));
    return lines.join('\n');
  }
}

export const incidentRunbook = new IncidentRunbook();

// Register default procedures
export function registerDefaultProcedures(): void {
  incidentRunbook.registerProcedure({
    name: 'Database Connection Loss',
    triggers: ['database_unavailable', 'connection_timeout', 'pool_exhausted'],
    severity: 'critical',
    estimatedDuration: 15,
    escalationPath: ['on-call-engineer', 'engineering-lead', 'director'],
    communicationTemplate: 'Database connection issue detected. Investigating connectivity and failover options.',
    steps: [
      {
        order: 1,
        action: 'Check database service health',
        expectedDuration: 2,
        successCriteria: 'Service responds to health check',
      },
      {
        order: 2,
        action: 'Verify network connectivity to database',
        expectedDuration: 2,
        successCriteria: 'Network latency < 50ms',
      },
      {
        order: 3,
        action: 'Attempt connection with retry backoff',
        expectedDuration: 3,
        successCriteria: 'Successful connection established',
      },
      {
        order: 4,
        action: 'Failover to replica if primary unavailable',
        expectedDuration: 5,
        successCriteria: 'Read/write operations restored',
      },
      {
        order: 5,
        action: 'Validate data consistency',
        expectedDuration: 3,
        successCriteria: 'No data integrity issues detected',
      },
    ],
  });

  incidentRunbook.registerProcedure({
    name: 'High Error Rate',
    triggers: ['error_rate_spike', 'error_threshold_exceeded', 'degraded_performance'],
    severity: 'high',
    estimatedDuration: 20,
    escalationPath: ['on-call-engineer', 'engineering-lead'],
    communicationTemplate: 'Error rate spike detected. Analyzing error patterns and root cause.',
    steps: [
      {
        order: 1,
        action: 'Collect error metrics and patterns',
        expectedDuration: 3,
        successCriteria: 'Root cause identified',
      },
      {
        order: 2,
        action: 'Check recent deployments',
        expectedDuration: 2,
        successCriteria: 'Identify deployment timeline',
      },
      {
        order: 3,
        action: 'Review application logs',
        expectedDuration: 5,
        successCriteria: 'Error pattern identified',
      },
      {
        order: 4,
        action: 'Implement fix or rollback',
        expectedDuration: 8,
        successCriteria: 'Error rate returns to baseline',
      },
      {
        order: 5,
        action: 'Verify system stability',
        expectedDuration: 2,
        successCriteria: 'Metrics normal for 5 minutes',
      },
    ],
  });

  incidentRunbook.registerProcedure({
    name: 'Webhook Delivery Failure',
    triggers: ['webhook_failure', 'delivery_timeout', 'signature_validation_failed'],
    severity: 'high',
    estimatedDuration: 15,
    escalationPath: ['on-call-engineer'],
    communicationTemplate: 'Webhook delivery issues detected. Investigating queue and retry logic.',
    steps: [
      {
        order: 1,
        action: 'Check webhook queue status',
        expectedDuration: 2,
        successCriteria: 'Queue metrics available',
      },
      {
        order: 2,
        action: 'Review failed webhook signatures',
        expectedDuration: 3,
        successCriteria: 'Validation errors identified',
      },
      {
        order: 3,
        action: 'Inspect subscriber endpoints',
        expectedDuration: 3,
        successCriteria: 'Endpoint health determined',
      },
      {
        order: 4,
        action: 'Retry failed deliveries',
        expectedDuration: 5,
        successCriteria: 'Successful delivery rate > 95%',
      },
      {
        order: 5,
        action: 'Notify affected subscribers',
        expectedDuration: 2,
        successCriteria: 'Notifications sent',
      },
    ],
  });
}
