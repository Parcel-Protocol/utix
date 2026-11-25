export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved';

export type RecoveryCheckStatus = 'passed' | 'failed' | 'rolled_back';

export type RecoveryErrorCode =
  | 'incident_not_found'
  | 'no_recovery_checks_defined'
  | 'unauthorized_operator'
  | 'check_execution_timeout'
  | 'recovery_verification_failed'
  | 'rollback_execution_failed';

export interface ExecutedRecoveryCheck {
  readonly name: string;
  readonly target?: string;
  readonly passed: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly rollbackOnFailure: boolean;
  readonly error?: string;
}

export interface RecoveryExecutionSummary {
  readonly incidentId: string;
  readonly passed: boolean;
  readonly status: RecoveryCheckStatus;
  readonly executedChecks: readonly ExecutedRecoveryCheck[];
  readonly totalDurationMs: number;
  readonly executedAt: string;
  readonly operator: string;
  readonly rollbackTriggered: boolean;
  readonly auditReceipt: string;
}

export interface RecoveryExecutionOptions {
  readonly actor: { readonly kind: 'operator' | 'maintainer' | 'system' | 'user'; readonly id: string };
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBackoffMs?: number;
  readonly abortOnFirstFailure?: boolean;
  readonly autoTriggerRollback?: boolean;
  readonly correlationId?: string;
}

export const INCIDENT_SCHEMA_VERSION = '1.0.0';

export type IncidentImportErrorCode =
  | 'invalid_envelope'
  | 'unsupported_schema_version'
  | 'invalid_incident_id'
  | 'invalid_timestamp'
  | 'invalid_severity'
  | 'invalid_status'
  | 'invalid_timeline'
  | 'invalid_mitigation_steps'
  | 'invalid_rollback_plan';

export interface IncidentContext {
  id: string;
  timestamp: Date;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string;
  affectedSystems: string[];
  timeline: TimelineEntry[];
  mitigationSteps: MitigationStep[];
  rollbackPlan?: RollbackPlan;
}

export interface TimelineEntry {
  timestamp: Date;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
}

export interface MitigationStep {
  order: number;
  action: string;
  expectedDuration: number;
  completed: boolean;
  completedAt?: Date;
  notes?: string;
}

export interface RollbackPlan {
  targetVersion: string;
  estimatedDuration: number;
  backupLocation: string;
  validationSteps: ValidationStep[];
  communicationScript: string;
}

export interface ValidationStep {
  name: string;
  check?: () => Promise<boolean>;
  rollbackOnFailure: boolean;
  checkType?: string;
  target?: string;
  expectedOutcome?: string;
}

export interface SerializedTimelineEntry {
  timestamp: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
}

export interface SerializedMitigationStep {
  order: number;
  action: string;
  expectedDuration: number;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

export interface SerializedValidationStep {
  name: string;
  rollbackOnFailure: boolean;
  checkType?: string;
  target?: string;
  expectedOutcome?: string;
}

export interface SerializedRollbackPlan {
  targetVersion: string;
  estimatedDuration: number;
  backupLocation: string;
  validationSteps: SerializedValidationStep[];
  communicationScript: string;
}

export interface SerializedIncidentContext {
  id: string;
  timestamp: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string;
  affectedSystems: string[];
  timeline: SerializedTimelineEntry[];
  mitigationSteps: SerializedMitigationStep[];
  rollbackPlan?: SerializedRollbackPlan;
}

export interface IncidentEnvelope {
  schemaVersion: string;
  exportedAt: string;
  incident: SerializedIncidentContext;
}

export interface RunbookProcedure {
  name: string;
  triggers: string[];
  severity: IncidentSeverity;
  estimatedDuration: number;
  steps: RunbookStep[];
  escalationPath: string[];
  communicationTemplate: string;
}

export interface RunbookStep {
  order: number;
  action: string;
  expectedDuration: number;
  successCriteria: string;
  fallbackAction?: string;
  validationCheck?: () => Promise<boolean>;
}
