/**
 * Types for operational health monitoring
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthIndicator {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
  lastChecked: Date;
}

export interface UnresolvedException {
  id: string;
  timestamp: Date;
  type: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  resolved: boolean;
}

export interface StaleRecord {
  id: string;
  type: string;
  age: number;
  lastActivity: Date;
  details: Record<string, unknown>;
}

export interface HealthSummary {
  timestamp: Date;
  overallStatus: HealthStatus;
  indicators: HealthIndicator[];
  unresolvedExceptions: UnresolvedException[];
  staleRecords: StaleRecord[];
  metrics: {
    totalFeatures: number;
    healthyFeatures: number;
    unresolvedExceptionCount: number;
    staleRecordCount: number;
  };
}
