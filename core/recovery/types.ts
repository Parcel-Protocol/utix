/**
 * Types for disaster recovery validation
 */

export type InvariantType =
  | 'missing-record'
  | 'orphaned-reference'
  | 'duplicate-record'
  | 'inconsistent-state'
  | 'invalid-reference'
  | 'clock-skew'
  | 'expired-record'
  | 'negative-elapsed-time'
  | 'future-timestamp';

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
  check: (options?: ValidationOptions) => Promise<InvariantViolation[]>;
}

export interface ClockSkewOptions {
  /** Tolerance window in milliseconds for acceptable drift. Defaults to 60,000ms (60s). */
  toleranceMs?: number;
  /** Injected clock function for deterministic testing. */
  now?: () => Date;
}

export interface RecoverableRecord {
  id: string;
  createdAt: Date | string | number;
  expiresAt?: Date | string | number;
  restoredAt?: Date | string | number;
  maxObservedTime?: Date | string | number;
  isExpired?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RestoreManifest {
  restoreId: string;
  backupTimestamp: Date | string | number;
  restoredAt: Date | string | number;
  timezoneOffsetMinutes?: number;
  records: RecoverableRecord[];
}

export interface ValidationOptions extends ClockSkewOptions {
  manifests?: RestoreManifest[];
}
