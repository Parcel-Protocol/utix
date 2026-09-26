/**
 * Operational health monitoring for maintainers
 * 
 * Aggregates health indicators, unresolved exceptions, and stale records
 * to provide actionable operational insights.
 */

import { HealthIndicator, HealthStatus, HealthSummary, UnresolvedException, StaleRecord } from './types';

class HealthMonitor {
  private indicators: HealthIndicator[] = [];
  private exceptions: UnresolvedException[] = [];
  private staleRecords: StaleRecord[] = [];

  async checkHealth(): Promise<HealthSummary> {
    await this.runHealthChecks();
    
    const unresolvedExceptions = this.exceptions.filter(e => !e.resolved);
    
    const overallStatus = this.computeOverallStatus();
    
    const healthyFeatures = this.indicators.filter(i => i.status === 'healthy').length;
    
    return {
      timestamp: new Date(),
      overallStatus,
      indicators: this.indicators,
      unresolvedExceptions,
      staleRecords: this.staleRecords,
      metrics: {
        totalFeatures: this.indicators.length,
        healthyFeatures,
        unresolvedExceptionCount: unresolvedExceptions.length,
        staleRecordCount: this.staleRecords.length,
      },
    };
  }

  private async runHealthChecks(): Promise<void> {
    this.indicators = [];
    
    await this.checkFeatureRegistry();
    await this.checkNetworkConnectivity();
    await this.checkEnvironmentConfiguration();
  }

  private async checkFeatureRegistry(): Promise<void> {
    try {
      const { registry } = await import('../registry/registry');
      const manifests = Object.values(registry);
      
      const status: HealthStatus = manifests.length > 0 ? 'healthy' : 'unhealthy';
      
      this.indicators.push({
        name: 'Feature Registry',
        status,
        message: `${manifests.length} features registered`,
        details: { 
          featureCount: manifests.length,
          features: manifests.map(m => m.slug),
        },
        lastChecked: new Date(),
      });
    } catch (error) {
      this.indicators.push({
        name: 'Feature Registry',
        status: 'unhealthy',
        message: 'Failed to load feature registry',
        details: { error: error instanceof Error ? error.message : String(error) },
        lastChecked: new Date(),
      });
      
      this.recordException({
        type: 'RegistryLoadError',
        message: 'Failed to load feature registry',
        error,
      });
    }
  }

  private async checkNetworkConnectivity(): Promise<void> {
    const endpoints = [
      { name: 'Horizon Testnet', url: process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL },
      { name: 'Horizon Mainnet', url: process.env.NEXT_PUBLIC_HORIZON_MAINNET_URL },
    ];
    
    for (const endpoint of endpoints) {
      if (!endpoint.url) {
        this.indicators.push({
          name: `Network: ${endpoint.name}`,
          status: 'degraded',
          message: 'Endpoint not configured',
          lastChecked: new Date(),
        });
        continue;
      }
      
      try {
        new URL(endpoint.url);
        
        this.indicators.push({
          name: `Network: ${endpoint.name}`,
          status: 'healthy',
          message: 'Endpoint configured',
          details: { url: endpoint.url },
          lastChecked: new Date(),
        });
      } catch {
        this.indicators.push({
          name: `Network: ${endpoint.name}`,
          status: 'unhealthy',
          message: 'Invalid endpoint URL',
          details: { url: endpoint.url },
          lastChecked: new Date(),
        });
      }
    }
  }

  private async checkEnvironmentConfiguration(): Promise<void> {
    const requiredVars = [
      'NEXT_PUBLIC_STELLAR_NETWORK',
      'NEXT_PUBLIC_HORIZON_TESTNET_URL',
      'NEXT_PUBLIC_HORIZON_MAINNET_URL',
    ];
    
    const missing = requiredVars.filter(v => !process.env[v]);
    
    if (missing.length === 0) {
      this.indicators.push({
        name: 'Environment Configuration',
        status: 'healthy',
        message: 'All required variables configured',
        lastChecked: new Date(),
      });
    } else {
      this.indicators.push({
        name: 'Environment Configuration',
        status: 'degraded',
        message: `${missing.length} required variable(s) not set`,
        details: { missing },
        lastChecked: new Date(),
      });
    }
  }

  private computeOverallStatus(): HealthStatus {
    if (this.indicators.some(i => i.status === 'unhealthy')) {
      return 'unhealthy';
    }
    if (this.indicators.some(i => i.status === 'degraded')) {
      return 'degraded';
    }
    return 'healthy';
  }

  recordException(params: {
    type: string;
    message: string;
    error?: unknown;
    context?: Record<string, unknown>;
  }): void {
    this.exceptions.push({
      id: `exc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      type: params.type,
      message: params.message,
      stack: params.error instanceof Error ? params.error.stack : undefined,
      context: params.context,
      resolved: false,
    });
  }

  recordStaleRecord(record: Omit<StaleRecord, 'age'>): void {
    const age = Date.now() - record.lastActivity.getTime();
    this.staleRecords.push({ ...record, age });
  }

  getUnresolvedExceptions(): UnresolvedException[] {
    return this.exceptions.filter(e => !e.resolved);
  }

  getStaleRecords(maxAgeMs: number): StaleRecord[] {
    return this.staleRecords.filter(r => r.age > maxAgeMs);
  }
}

export const healthMonitor = new HealthMonitor();

export function formatHealthReport(summary: HealthSummary): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(70));
  lines.push('OPERATIONAL HEALTH DASHBOARD');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`Timestamp: ${summary.timestamp.toISOString()}`);
  lines.push(`Overall Status: ${summary.overallStatus.toUpperCase()}`);
  lines.push('');
  
  lines.push('METRICS:');
  lines.push(`  Features: ${summary.metrics.healthyFeatures}/${summary.metrics.totalFeatures} healthy`);
  lines.push(`  Unresolved Exceptions: ${summary.metrics.unresolvedExceptionCount}`);
  lines.push(`  Stale Records: ${summary.metrics.staleRecordCount}`);
  lines.push('');
  
  lines.push('HEALTH INDICATORS:');
  for (const indicator of summary.indicators) {
    const statusSymbol = {
      healthy: '✓',
      degraded: '!',
      unhealthy: '✗',
    }[indicator.status];
    
    lines.push(`  ${statusSymbol} ${indicator.name}: ${indicator.message}`);
  }
  lines.push('');
  
  if (summary.unresolvedExceptions.length > 0) {
    lines.push(`UNRESOLVED EXCEPTIONS (${summary.unresolvedExceptions.length}):`);
    summary.unresolvedExceptions.slice(0, 10).forEach((exc, i) => {
      lines.push(`  ${i + 1}. [${exc.type}] ${exc.message}`);
      lines.push(`     Timestamp: ${exc.timestamp.toISOString()}`);
      lines.push(`     ID: ${exc.id}`);
    });
    
    if (summary.unresolvedExceptions.length > 10) {
      lines.push(`  ... and ${summary.unresolvedExceptions.length - 10} more`);
    }
    lines.push('');
  }
  
  if (summary.staleRecords.length > 0) {
    lines.push(`STALE RECORDS (${summary.staleRecords.length}):`);
    summary.staleRecords.slice(0, 10).forEach((record, i) => {
      const ageDays = Math.floor(record.age / (1000 * 60 * 60 * 24));
      lines.push(`  ${i + 1}. ${record.type} (${ageDays} days old)`);
      lines.push(`     ID: ${record.id}`);
      lines.push(`     Last Activity: ${record.lastActivity.toISOString()}`);
    });
    
    if (summary.staleRecords.length > 10) {
      lines.push(`  ... and ${summary.staleRecords.length - 10} more`);
    }
    lines.push('');
  }
  
  lines.push('='.repeat(70));
  
  return lines.join('\n');
}
