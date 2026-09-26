import crypto from 'crypto';
import {
  PrivacyPreservingEvent,
  AggregatedMetric,
  AnalyticsSummary,
  AnalyticsConfig,
  MaintainerInsight,
  AggregationLevel,
  EventCategory,
  PerformanceMetrics,
} from './types';

class AnalyticsAggregator {
  private events: PrivacyPreservingEvent[] = [];
  private metrics: Map<string, AggregatedMetric> = new Map();
  private insights: MaintainerInsight[] = [];

  private defaultConfig: AnalyticsConfig = {
    enablePII: false,
    hashingAlgorithm: 'sha256',
    retentionDays: 90,
    aggregationIntervals: ['minute', 'hour', 'day'],
    samplingRate: 1.0,
    redactedFields: ['password', 'token', 'secret', 'key', 'authorization'],
  };

  constructor(private config: Partial<AnalyticsConfig> = {}) {
    this.config = { ...this.defaultConfig, ...config };
  }

  private hashIdentifier(value: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
    if (this.config.enablePII) return value;
    return crypto.createHash(algorithm).update(value).digest('hex');
  }

  private shouldSample(): boolean {
    return Math.random() < (this.config.samplingRate || 1.0);
  }

  private redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    if (this.config.enablePII) return metadata;

    const redacted: Record<string, unknown> = {};
    const redactedFields = this.config.redactedFields || [];

    for (const [key, value] of Object.entries(metadata)) {
      if (redactedFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactMetadata(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  recordEvent(params: {
    category: EventCategory;
    eventType: string;
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): PrivacyPreservingEvent | null {
    if (!this.shouldSample()) return null;

    const event: PrivacyPreservingEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      category: params.category,
      eventType: params.eventType,
      userId: this.hashIdentifier(params.userId || 'anonymous'),
      sessionId: this.hashIdentifier(params.sessionId || 'unknown'),
      anonymousId: crypto.randomBytes(16).toString('hex'),
      metadata: this.redactMetadata(params.metadata || {}),
      tags: params.tags || [],
    };

    this.events.push(event);
    this.updateAggregates(event);

    return event;
  }

  private updateAggregates(event: PrivacyPreservingEvent): void {
    const aggregationLevels = this.config.aggregationIntervals || ['minute', 'hour', 'day'];

    for (const level of aggregationLevels) {
      const timestamp = this.getAggregationBucket(event.timestamp, level);
      const key = `${event.eventType}-${timestamp.toISOString()}-${level}`;

      let metric = this.metrics.get(key);
      if (!metric) {
        metric = {
          id: `metric-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp,
          aggregationLevel: level as AggregationLevel,
          eventType: event.eventType,
          category: event.category,
          count: 0,
          metadata: {},
        };
        this.metrics.set(key, metric);
      }

      metric.count++;
    }
  }

  private getAggregationBucket(date: Date, level: AggregationLevel): Date {
    const d = new Date(date);

    switch (level) {
      case 'minute':
        d.setSeconds(0, 0);
        break;
      case 'hour':
        d.setMinutes(0, 0, 0);
        break;
      case 'day':
        d.setHours(0, 0, 0, 0);
        break;
      case 'week':
        d.setDate(d.getDate() - d.getDay());
        d.setHours(0, 0, 0, 0);
        break;
    }

    return d;
  }

  async generateMaintainerInsights(): Promise<MaintainerInsight[]> {
    const newInsights: MaintainerInsight[] = [];

    // Detect usage trends
    const usageTrend = this.analyzeUsageTrend();
    if (usageTrend) newInsights.push(usageTrend);

    // Detect error spikes
    const errorSpike = this.analyzeErrorSpike();
    if (errorSpike) newInsights.push(errorSpike);

    // Detect performance degradation
    const perfDegradation = this.analyzePerformanceDegradation();
    if (perfDegradation) newInsights.push(perfDegradation);

    // Detect feature adoption
    const featureAdoption = this.analyzeFeatureAdoption();
    if (featureAdoption) newInsights.push(featureAdoption);

    this.insights.push(...newInsights);
    return newInsights;
  }

  private analyzeUsageTrend(): MaintainerInsight | null {
    const recentEvents = this.events.filter(
      e => Date.now() - e.timestamp.getTime() < 1000 * 60 * 60 * 24,
    );

    if (recentEvents.length < 10) return null;

    const eventCounts = new Map<string, number>();
    for (const event of recentEvents) {
      eventCounts.set(event.eventType, (eventCounts.get(event.eventType) || 0) + 1);
    }

    const topEvent = Array.from(eventCounts.entries()).sort((a, b) => b[1] - a[1])[0];

    if (!topEvent) return null;

    return {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      type: 'usage_trend',
      title: `High usage of "${topEvent[0]}"`,
      description: `Event type "${topEvent[0]}" recorded ${topEvent[1]} times in the last 24 hours`,
      severity: 'info',
      data: { eventType: topEvent[0], count: topEvent[1] },
      actionItems: [],
    };
  }

  private analyzeErrorSpike(): MaintainerInsight | null {
    const recentErrors = this.events.filter(
      e =>
        e.category === 'error' &&
        Date.now() - e.timestamp.getTime() < 1000 * 60 * 60,
    );

    if (recentErrors.length < 5) return null;

    const errorRate = recentErrors.length / Math.max(this.events.length, 1);
    if (errorRate < 0.1) return null;

    const errorTypes = new Map<string, number>();
    for (const error of recentErrors) {
      errorTypes.set(error.eventType, (errorTypes.get(error.eventType) || 0) + 1);
    }

    return {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      type: 'error_spike',
      title: 'Elevated error rate detected',
      description: `Error rate is ${(errorRate * 100).toFixed(1)}% in the last hour`,
      severity: 'warning',
      data: { errorCount: recentErrors.length, errorRate, topErrors: Object.fromEntries(errorTypes) },
      actionItems: [
        'Review recent error logs',
        'Check application health metrics',
        'Investigate error sources',
      ],
    };
  }

  private analyzePerformanceDegradation(): MaintainerInsight | null {
    const perfEvents = this.events.filter(
      e =>
        e.category === 'performance' &&
        Date.now() - e.timestamp.getTime() < 1000 * 60 * 60,
    );

    if (perfEvents.length < 5) return null;

    const responseTimes = perfEvents
      .map(e => (e.metadata?.responseTime as number) || 0)
      .filter(t => t > 0);

    if (responseTimes.length === 0) return null;

    const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

    if (avgResponseTime < 500) return null;

    return {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      type: 'performance_degradation',
      title: 'Performance degradation detected',
      description: `Average response time is ${avgResponseTime.toFixed(0)}ms (threshold: 500ms)`,
      severity: 'warning',
      data: { averageResponseTime: avgResponseTime, sampleCount: responseTimes.length },
      actionItems: [
        'Check database performance',
        'Review slow queries',
        'Analyze resource utilization',
        'Consider caching strategies',
      ],
    };
  }

  private analyzeFeatureAdoption(): MaintainerInsight | null {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayEvents = this.events.filter(e => e.timestamp >= today).length;
    const yesterdayEvents = this.events.filter(
      e => e.timestamp >= yesterday && e.timestamp < today,
    ).length;

    if (yesterdayEvents === 0) return null;

    const growthRate = (todayEvents - yesterdayEvents) / yesterdayEvents;

    if (Math.abs(growthRate) < 0.2) return null;

    const direction = growthRate > 0 ? 'increased' : 'decreased';

    return {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      type: 'feature_adoption',
      title: `Feature usage ${direction}`,
      description: `Usage ${direction} by ${Math.abs(growthRate * 100).toFixed(1)}% compared to yesterday`,
      severity: 'info',
      data: { todayCount: todayEvents, yesterdayCount: yesterdayEvents, growthRate },
      actionItems: [],
    };
  }

  async generateSummary(period: AggregationLevel): Promise<AnalyticsSummary> {
    const aggregationDate = this.getAggregationBucket(new Date(), period);

    const relevantMetrics = Array.from(this.metrics.values()).filter(
      m => m.aggregationLevel === period && m.timestamp.getTime() === aggregationDate.getTime(),
    );

    const eventsByType = new Map<string, number>();
    const eventsByCategory = new Map<EventCategory, number>();

    for (const metric of relevantMetrics) {
      eventsByType.set(metric.eventType, (eventsByType.get(metric.eventType) || 0) + metric.count);
      eventsByCategory.set(
        metric.category,
        (eventsByCategory.get(metric.category) || 0) + metric.count,
      );
    }

    const totalEvents = Array.from(eventsByType.values()).reduce((a, b) => a + b, 0);
    const errorCount = eventsByCategory.get('error') || 0;
    const errorRate = totalEvents > 0 ? errorCount / totalEvents : 0;

    const topFeatures = Array.from(eventsByType.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const perfMetrics = this.calculatePerformanceMetrics();

    return {
      timestamp: aggregationDate,
      period,
      totalEvents,
      eventsByType: Object.fromEntries(eventsByType),
      eventsByCategory: Object.fromEntries(eventsByCategory),
      topFeatures,
      errorRate,
      performanceMetrics: perfMetrics,
    };
  }

  private calculatePerformanceMetrics(): PerformanceMetrics {
    const perfEvents = this.events
      .filter(e => e.category === 'performance')
      .map(e => (e.metadata?.responseTime as number) || 0)
      .filter(t => t > 0)
      .sort((a, b) => a - b);

    if (perfEvents.length === 0) {
      return {
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        errorCount: 0,
      };
    }

    const average = perfEvents.reduce((a, b) => a + b, 0) / perfEvents.length;
    const p95Index = Math.floor(perfEvents.length * 0.95);
    const p99Index = Math.floor(perfEvents.length * 0.99);

    return {
      averageResponseTime: average,
      p95ResponseTime: perfEvents[p95Index],
      p99ResponseTime: perfEvents[p99Index],
      errorCount: this.events.filter(e => e.category === 'error').length,
    };
  }

  cleanup(olderThanDays: number = this.config.retentionDays || 90): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const initialLength = this.events.length;

    this.events = this.events.filter(e => e.timestamp.getTime() > cutoff);

    return initialLength - this.events.length;
  }

  getEventCount(): number {
    return this.events.length;
  }

  getInsights(): MaintainerInsight[] {
    return this.insights;
  }

  clearOldInsights(olderThanDays: number = 30): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const initialLength = this.insights.length;

    this.insights = this.insights.filter(i => i.timestamp.getTime() > cutoff);

    return initialLength - this.insights.length;
  }
}

export const analyticsAggregator = new AnalyticsAggregator();
