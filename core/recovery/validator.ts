/**
 * Disaster recovery validation for core domain invariants
 * 
 * This module provides read-only validation checks to verify data integrity
 * after restore or migration operations.
 */

import { InvariantCheck, InvariantViolation, ValidationResult } from './types';

class RecoveryValidator {
  private checks: InvariantCheck[] = [];

  registerCheck(check: InvariantCheck): void {
    this.checks.push(check);
  }

  async validate(): Promise<ValidationResult> {
    const timestamp = new Date();
    const violations: InvariantViolation[] = [];
    let passedChecks = 0;
    let failedChecks = 0;

    for (const check of this.checks) {
      try {
        const checkViolations = await check.check();
        
        if (checkViolations.length === 0) {
          passedChecks++;
        } else {
          failedChecks++;
          violations.push(...checkViolations);
        }
      } catch (error) {
        failedChecks++;
        violations.push({
          type: 'inconsistent-state',
          severity: 'critical',
          message: `Check "${check.name}" failed with error`,
          details: {
            checkName: check.name,
            error: error instanceof Error ? error.message : String(error),
          },
          affectedRecords: [],
        });
      }
    }

    return {
      timestamp,
      passed: violations.length === 0,
      violations,
      checks: {
        total: this.checks.length,
        passed: passedChecks,
        failed: failedChecks,
      },
    };
  }

  getRegisteredChecks(): readonly InvariantCheck[] {
    return [...this.checks];
  }
}

export const validator = new RecoveryValidator();

// Core invariant checks for Utix

validator.registerCheck({
  name: 'registry-manifest-consistency',
  description: 'Verify all feature manifests are valid and consistent',
  check: async () => {
    const violations: InvariantViolation[] = [];
    
    try {
      const { registry } = await import('../registry/registry');
      const manifests = Object.values(registry);
      
      const slugs = new Set<string>();
      
      for (const manifest of manifests) {
        if (slugs.has(manifest.slug)) {
          violations.push({
            type: 'duplicate-record',
            severity: 'critical',
            message: `Duplicate feature slug detected: ${manifest.slug}`,
            details: { slug: manifest.slug },
            affectedRecords: [manifest.slug],
          });
        }
        slugs.add(manifest.slug);
        
        if (!manifest.title || !manifest.description) {
          violations.push({
            type: 'inconsistent-state',
            severity: 'warning',
            message: `Feature ${manifest.slug} has incomplete metadata`,
            details: { 
              slug: manifest.slug,
              hasTitle: !!manifest.title,
              hasDescription: !!manifest.description,
            },
            affectedRecords: [manifest.slug],
          });
        }
      }
    } catch (error) {
      violations.push({
        type: 'missing-record',
        severity: 'critical',
        message: 'Failed to load feature registry',
        details: { error: error instanceof Error ? error.message : String(error) },
        affectedRecords: [],
      });
    }
    
    return violations;
  },
});

validator.registerCheck({
  name: 'network-configuration-validity',
  description: 'Verify network configuration is complete and valid',
  check: async () => {
    const violations: InvariantViolation[] = [];
    
    const requiredConfigs = [
      'NEXT_PUBLIC_HORIZON_TESTNET_URL',
      'NEXT_PUBLIC_HORIZON_MAINNET_URL',
    ];
    
    for (const config of requiredConfigs) {
      const value = process.env[config];
      if (!value) {
        violations.push({
          type: 'missing-record',
          severity: 'warning',
          message: `Missing network configuration: ${config}`,
          details: { configKey: config },
          affectedRecords: [config],
        });
      } else {
        try {
          new URL(value);
        } catch {
          violations.push({
            type: 'invalid-reference',
            severity: 'critical',
            message: `Invalid URL in network configuration: ${config}`,
            details: { configKey: config, value },
            affectedRecords: [config],
          });
        }
      }
    }
    
    return violations;
  },
});

export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(70));
  lines.push('DISASTER RECOVERY VALIDATION REPORT');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`Timestamp: ${result.timestamp.toISOString()}`);
  lines.push(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');
  lines.push(`Checks: ${result.checks.passed} passed, ${result.checks.failed} failed, ${result.checks.total} total`);
  lines.push('');
  
  if (result.violations.length === 0) {
    lines.push('All invariants validated successfully.');
  } else {
    lines.push(`Found ${result.violations.length} violation(s):`);
    lines.push('');
    
    const critical = result.violations.filter(v => v.severity === 'critical');
    const warnings = result.violations.filter(v => v.severity === 'warning');
    
    if (critical.length > 0) {
      lines.push(`CRITICAL (${critical.length}):`);
      critical.forEach((v, i) => {
        lines.push(`  ${i + 1}. [${v.type}] ${v.message}`);
        if (v.affectedRecords.length > 0) {
          lines.push(`     Affected: ${v.affectedRecords.join(', ')}`);
        }
      });
      lines.push('');
    }
    
    if (warnings.length > 0) {
      lines.push(`WARNINGS (${warnings.length}):`);
      warnings.forEach((v, i) => {
        lines.push(`  ${i + 1}. [${v.type}] ${v.message}`);
        if (v.affectedRecords.length > 0) {
          lines.push(`     Affected: ${v.affectedRecords.join(', ')}`);
        }
      });
      lines.push('');
    }
  }
  
  lines.push('='.repeat(70));
  
  return lines.join('\n');
}
