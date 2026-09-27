import {
  IncidentContext,
  IncidentEnvelope,
  IncidentImportErrorCode,
  IncidentSeverity,
  IncidentStatus,
  INCIDENT_SCHEMA_VERSION,
  MitigationStep,
  RollbackPlan,
  RunbookProcedure,
  SerializedIncidentContext,
  SerializedMitigationStep,
  SerializedRollbackPlan,
  SerializedTimelineEntry,
  TimelineEntry,
  ValidationStep
} from './types';
import { err, ok, type Result } from '@/core/result/result';
import { redact } from '@/core/telemetry/telemetry';

export function serializeTimeline(timeline: TimelineEntry[]): SerializedTimelineEntry[] {
  return timeline.map((entry) => ({
    timestamp: entry.timestamp.toISOString(),
    action: entry.action,
    actor: entry.actor,
    details: entry.details ? (redact(entry.details) as Record<string, unknown>) : undefined
  }));
}

export function deserializeTimeline(serialized: unknown): Result<TimelineEntry[], 'invalid_timeline'> {
  if (!Array.isArray(serialized)) return err('invalid_timeline');

  const timeline: TimelineEntry[] = [];
  for (const item of serialized) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.timestamp !== 'string' ||
      isNaN(new Date(item.timestamp).getTime()) ||
      typeof item.action !== 'string' ||
      item.action.trim().length === 0 ||
      typeof item.actor !== 'string' ||
      item.actor.trim().length === 0
    ) {
      return err('invalid_timeline');
    }

    timeline.push({
      timestamp: new Date(item.timestamp),
      action: item.action,
      actor: item.actor,
      details: item.details
    });
  }

  return ok(timeline);
}

const STELLAR_SECRET_PATTERN = /[SM][A-Z2-7]{55}/g;
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+/gi;

export function scrubIncidentSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(STELLAR_SECRET_PATTERN, '[REDACTED]')
      .replace(BEARER_TOKEN_PATTERN, '[REDACTED]');
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrubIncidentSecrets);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (/secret|seed|password|passphrase|token|auth|credential|bearer|cookie/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = scrubIncidentSecrets(val);
    }
  }
  return out;
}

export function serializeIncident(incident: IncidentContext): IncidentEnvelope {
  const serializedTimeline = serializeTimeline(incident.timeline);

  const serializedMitigation: SerializedMitigationStep[] = incident.mitigationSteps.map((step) => ({
    order: step.order,
    action: step.action,
    expectedDuration: step.expectedDuration,
    completed: step.completed,
    completedAt: step.completedAt ? step.completedAt.toISOString() : undefined,
    notes: step.notes
  }));

  let serializedRollback: SerializedRollbackPlan | undefined;
  if (incident.rollbackPlan) {
    serializedRollback = {
      targetVersion: incident.rollbackPlan.targetVersion,
      estimatedDuration: incident.rollbackPlan.estimatedDuration,
      backupLocation: incident.rollbackPlan.backupLocation,
      communicationScript: incident.rollbackPlan.communicationScript,
      validationSteps: incident.rollbackPlan.validationSteps.map((step) => ({
        name: step.name,
        rollbackOnFailure: step.rollbackOnFailure,
        checkType: step.checkType,
        target: step.target,
        expectedOutcome: step.expectedOutcome
      }))
    };
  }

  const serializedContext: SerializedIncidentContext = {
    id: incident.id,
    timestamp: incident.timestamp.toISOString(),
    severity: incident.severity,
    status: incident.status,
    title: incident.title,
    description: incident.description,
    affectedSystems: [...incident.affectedSystems],
    timeline: serializedTimeline,
    mitigationSteps: serializedMitigation,
    rollbackPlan: serializedRollback
  };

  const rawEnvelope: IncidentEnvelope = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    incident: serializedContext
  };

  return scrubIncidentSecrets(rawEnvelope) as IncidentEnvelope;
}

export function deserializeIncident(data: unknown): Result<IncidentContext, IncidentImportErrorCode> {
  if (typeof data !== 'object' || data === null) {
    return err('invalid_envelope');
  }

  const envelope = data as Partial<IncidentEnvelope>;
  if (!envelope.schemaVersion || typeof envelope.schemaVersion !== 'string' || !envelope.schemaVersion.startsWith('1.')) {
    return err('unsupported_schema_version');
  }

  if (!envelope.incident || typeof envelope.incident !== 'object' || envelope.incident === null) {
    return err('invalid_envelope');
  }

  const inc = envelope.incident as Partial<SerializedIncidentContext>;

  if (typeof inc.id !== 'string' || inc.id.trim().length === 0) {
    return err('invalid_incident_id');
  }

  if (typeof inc.timestamp !== 'string' || isNaN(new Date(inc.timestamp).getTime())) {
    return err('invalid_timestamp');
  }

  const validSeverities: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];
  if (!inc.severity || !validSeverities.includes(inc.severity)) {
    return err('invalid_severity');
  }

  const validStatuses: IncidentStatus[] = ['open', 'investigating', 'mitigated', 'resolved'];
  if (!inc.status || !validStatuses.includes(inc.status)) {
    return err('invalid_status');
  }

  if (typeof inc.title !== 'string' || inc.title.trim().length === 0) {
    return err('invalid_envelope');
  }

  if (!Array.isArray(inc.affectedSystems)) {
    return err('invalid_envelope');
  }

  const timelineResult = deserializeTimeline(inc.timeline);
  if (!timelineResult.ok) {
    return err('invalid_timeline');
  }

  if (!Array.isArray(inc.mitigationSteps)) {
    return err('invalid_mitigation_steps');
  }

  const mitigationSteps: MitigationStep[] = [];
  for (const step of inc.mitigationSteps) {
    if (
      typeof step !== 'object' ||
      step === null ||
      typeof step.order !== 'number' ||
      !Number.isInteger(step.order) ||
      step.order <= 0 ||
      typeof step.action !== 'string' ||
      step.action.trim().length === 0 ||
      typeof step.expectedDuration !== 'number' ||
      step.expectedDuration < 0 ||
      typeof step.completed !== 'boolean'
    ) {
      return err('invalid_mitigation_steps');
    }

    let completedAt: Date | undefined;
    if (step.completedAt !== undefined) {
      if (typeof step.completedAt !== 'string' || isNaN(new Date(step.completedAt).getTime())) {
        return err('invalid_mitigation_steps');
      }
      completedAt = new Date(step.completedAt);
    }

    mitigationSteps.push({
      order: step.order,
      action: step.action,
      expectedDuration: step.expectedDuration,
      completed: step.completed,
      completedAt,
      notes: typeof step.notes === 'string' ? step.notes : undefined
    });
  }

  let rollbackPlan: RollbackPlan | undefined;
  if (inc.rollbackPlan !== undefined) {
    const rp = inc.rollbackPlan;
    if (
      typeof rp !== 'object' ||
      rp === null ||
      typeof rp.targetVersion !== 'string' ||
      typeof rp.estimatedDuration !== 'number' ||
      rp.estimatedDuration < 0 ||
      typeof rp.backupLocation !== 'string' ||
      typeof rp.communicationScript !== 'string' ||
      !Array.isArray(rp.validationSteps)
    ) {
      return err('invalid_rollback_plan');
    }

    const validationSteps: ValidationStep[] = [];
    for (const vs of rp.validationSteps) {
      if (
        typeof vs !== 'object' ||
        vs === null ||
        typeof vs.name !== 'string' ||
        vs.name.trim().length === 0 ||
        typeof vs.rollbackOnFailure !== 'boolean'
      ) {
        return err('invalid_rollback_plan');
      }

      validationSteps.push({
        name: vs.name,
        rollbackOnFailure: vs.rollbackOnFailure,
        checkType: vs.checkType,
        target: vs.target,
        expectedOutcome: vs.expectedOutcome
      });
    }

    rollbackPlan = {
      targetVersion: rp.targetVersion,
      estimatedDuration: rp.estimatedDuration,
      backupLocation: rp.backupLocation,
      communicationScript: rp.communicationScript,
      validationSteps
    };
  }

  return ok({
    id: inc.id,
    timestamp: new Date(inc.timestamp),
    severity: inc.severity,
    status: inc.status,
    title: inc.title,
    description: typeof inc.description === 'string' ? inc.description : '',
    affectedSystems: inc.affectedSystems.map(String),
    timeline: timelineResult.value,
    mitigationSteps,
    rollbackPlan
  });
}

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

  setRollbackPlan(incidentId: string, plan: RollbackPlan): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);
    incident.rollbackPlan = plan;
  }

  exportIncident(incidentId: string): Result<IncidentEnvelope, 'incident_not_found'> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return err('incident_not_found');
    return ok(serializeIncident(incident));
  }

  importIncident(envelope: unknown): Result<IncidentContext, IncidentImportErrorCode> {
    const result = deserializeIncident(envelope);
    if (!result.ok) return result;
    this.incidents.set(result.value.id, result.value);
    return ok(result.value);
  }

  reset(): void {
    this.incidents.clear();
    this.procedures.clear();
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
