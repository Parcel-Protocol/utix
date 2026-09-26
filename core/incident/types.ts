export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved';

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
  check: () => Promise<boolean>;
  rollbackOnFailure: boolean;
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
