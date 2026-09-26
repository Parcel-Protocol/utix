#!/usr/bin/env node

/**
 * Operational health check command
 * 
 * Generates a dashboard showing system health, unresolved exceptions,
 * and stale records for maintainer review.
 * 
 * Usage:
 *   npm run health:check
 *   node scripts/health-check.mjs
 *   node scripts/health-check.mjs --json
 */

import { healthMonitor, formatHealthReport } from '../core/health/monitor.ts';

async function main() {
  const isJson = process.argv.includes('--json');
  
  try {
    const summary = await healthMonitor.checkHealth();
    
    if (isJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatHealthReport(summary));
    }
    
    process.exit(summary.overallStatus === 'unhealthy' ? 1 : 0);
  } catch (error) {
    console.error('Health check failed with error:');
    console.error(error);
    process.exit(2);
  }
}

main();
