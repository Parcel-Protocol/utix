/**
 * Types for disaster recovery validation
 */

export type InvariantType =
  | 'missing-record'
  | 'orphaned-reference'
  | 'duplicate-record'
  | 'inconsistent-state'
  | 'invalid-reference';

export interface InvariantViolation {
  type: InvariantType;
  severity: 'critical' | 'warning';
  message: string;
  details: Record<string, unknown>;
  affectedRecords: string[];
}

export interface ValidationResult {
  timestamp: Date;
  passed: boolean;
  violations: InvariantViolation[];
  checks: {
    total: number;
    passed: number;
    failed: number;
  };
}

export interface InvariantCheck {
  name: string;
  description: string;
  check: () => Promise<InvariantViolation[]>;
}
