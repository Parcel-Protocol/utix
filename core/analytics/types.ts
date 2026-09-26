export type EventCategory = 'feature_usage' | 'error' | 'performance' | 'user_action';
export type AggregationLevel = 'minute' | 'hour' | 'day' | 'week';

export interface PrivacyPreservingEvent {
  id: string;
  timestamp: Date;
  category: EventCategory;
  eventType: string;
  userId: string; // Hashed identifier
  sessionId: string; // Hashed identifier
  anonymousId: string; // Random identifier
  metadata: Record<string, unknown>;
  tags: string[];
}

export interface AggregatedMetric {
  id: string;
  timestamp: Date;
  aggregationLevel: AggregationLevel;
  eventType: string;
  category: EventCategory;
  count: number;
  metadata: Record<string, number | string>;
}

export interface AnalyticsSummary {
  timestamp: Date;
  period: AggregationLevel;
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByCategory: Record<EventCategory, number>;
  topFeatures: Array<{ name: string; count: number }>;
  errorRate: number;
  performanceMetrics: PerformanceMetrics;
}

export interface PerformanceMetrics {
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  errorCount: number;
}

export interface AnalyticsConfig {
  enablePII: boolean;
  hashingAlgorithm: 'sha256' | 'sha512';
  retentionDays: number;
  aggregationIntervals: AggregationLevel[];
  samplingRate: number;
  redactedFields: string[];
}

export interface MaintainerInsight {
  id: string;
  timestamp: Date;
  type: 'usage_trend' | 'error_spike' | 'performance_degradation' | 'feature_adoption';
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
  actionItems: string[];
}
