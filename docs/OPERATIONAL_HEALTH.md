# Operational Health Dashboard

The operational health dashboard provides maintainers with actionable insights into system health, unresolved exceptions, and operational issues.

## Quick Start

```bash
npm run health:check
```

This command generates a comprehensive health report showing:
- Overall system status
- Health indicators for each component
- Unresolved exceptions
- Stale records requiring attention
- Key operational metrics

## Health Indicators

The dashboard monitors these critical components:

### Feature Registry
Status of the feature manifest system. Unhealthy status indicates registry load failures or corruption.

### Network Connectivity
Configuration status for Stellar network endpoints. Checks both testnet and mainnet URLs.

### Environment Configuration
Validates presence and validity of required environment variables.

## Status Levels

**Healthy**
All indicators are operating normally. No immediate action required.

**Degraded**
One or more indicators show warnings. System is functional but attention may be needed.

**Unhealthy**
Critical issues detected. Immediate investigation and remediation required.

## Unresolved Exceptions

The dashboard tracks exceptions that have not been resolved:
- Exception type and message
- Timestamp and unique ID
- Stack trace when available
- Contextual information

### Recording Exceptions

Components can record exceptions for tracking:

```typescript
import { healthMonitor } from '@/core/health/monitor';

healthMonitor.recordException({
  type: 'DataLoadError',
  message: 'Failed to load critical data',
  error: caughtError,
  context: { userId: '123', action: 'load' },
});
```

## Stale Records

Track records that have not been updated within expected timeframes:

```typescript
healthMonitor.recordStaleRecord({
  id: 'record-123',
  type: 'UserSession',
  lastActivity: new Date('2026-01-01'),
  details: { userId: '123' },
});
```

Query stale records by age:

```typescript
const weekOldRecords = healthMonitor.getStaleRecords(
  1000 * 60 * 60 * 24 * 7 // 7 days in milliseconds
);
```

## Output Formats

### Human-Readable

Default output provides formatted dashboard for manual review:

```bash
npm run health:check
```

### JSON

Machine-readable format for integration with monitoring systems:

```bash
npm run health:check -- --json
```

Example JSON output:

```json
{
  "timestamp": "2026-09-25T00:00:00.000Z",
  "overallStatus": "healthy",
  "indicators": [...],
  "unresolvedExceptions": [...],
  "staleRecords": [...],
  "metrics": {
    "totalFeatures": 10,
    "healthyFeatures": 10,
    "unresolvedExceptionCount": 0,
    "staleRecordCount": 0
  }
}
```

## Exit Codes

- **0** - System is healthy or degraded
- **1** - System is unhealthy
- **2** - Health check script error

## Monitoring Integration

### Automated Monitoring

Add health checks to your monitoring pipeline:

```yaml
- name: Check operational health
  run: npm run health:check -- --json > health-report.json
```

### Alert Configuration

Set up alerts based on health status:

```bash
STATUS=$(npm run health:check -- --json | jq -r '.overallStatus')
if [ "$STATUS" = "unhealthy" ]; then
  # Trigger alert
fi
```

### Scheduled Checks

Run health checks on a schedule:

```bash
# Crontab entry for hourly checks
0 * * * * cd /path/to/utix && npm run health:check >> /var/log/utix-health.log 2>&1
```

## Investigation Links

When issues are detected:

1. Review full exception details including stack traces
2. Check affected record IDs against logs
3. Cross-reference with deployment timeline
4. Verify network and infrastructure status
5. Run disaster recovery validation if needed

## Sensitive Information

The health dashboard automatically redacts:
- Authentication tokens
- Private keys
- User personally identifiable information
- Internal infrastructure details

Only aggregated metrics and sanitized identifiers are included.

## Adding Health Checks

To add custom health indicators:

1. Edit `core/health/monitor.ts`
2. Add your check method to `HealthMonitor` class
3. Call it from `runHealthChecks()`
4. Add test coverage in `core/health/__tests__/monitor.test.ts`

Example:

```typescript
private async checkCustomComponent(): Promise<void> {
  try {
    // Your health check logic
    
    this.indicators.push({
      name: 'Custom Component',
      status: 'healthy',
      message: 'Component is operational',
      lastChecked: new Date(),
    });
  } catch (error) {
    this.indicators.push({
      name: 'Custom Component',
      status: 'unhealthy',
      message: 'Component check failed',
      details: { error: String(error) },
      lastChecked: new Date(),
    });
  }
}
```

## Best Practices

- Run health checks after deployments
- Monitor health check exit codes in CI/CD
- Archive health reports for trend analysis
- Investigate degraded status before it becomes unhealthy
- Document resolution steps for common issues
- Keep exception context minimal but actionable
- Set reasonable thresholds for stale record alerts
