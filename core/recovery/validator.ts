/**
 * Disaster recovery validation for core domain invariants
 * 
 * This module provides read-only validation checks to verify data integrity
 * after restore or migration operations.
 */

import type {
  ClockSkewOptions,
  InvariantCheck,
  InvariantViolation,
  RecoverableRecord,
  RestoreManifest,
  ValidationOptions,
  ValidationResult
} from './types.ts';

/**
 * Maximum permitted clock drift / skew tolerance in milliseconds.
 * Future timestamps within this window are tolerated; timestamps further into the
 * future indicate invalid or desynchronized clocks.
 */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 60_000; // 60 seconds

/**
 * Normalizes any timestamp representation (Date, string, number) to UTC milliseconds.
 * Returns null if the timestamp is unparseable or non-finite.
 */
export function normalizeToUtcMs(time: Date | string | number | undefined | null): number | null {
  if (time == null) return null;
  if (typeof time === "number") {
    return Number.isFinite(time) ? time : null;
  }
  const parsed = new Date(time).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Conservative expiry check.
 * Guarantees that:
 * 1. A record marked expired remains expired.
 * 2. If time ever reached or passed expiresAt (monotonic watermark maxObservedTime),
 *    a backwards-moving client clock cannot make expired data look freshly restored.
 * 3. A restore happening at or after expiresAt marks the record as expired.
 */
export function isExpiredConservatively(
  record: RecoverableRecord,
  nowUtc: number,
  toleranceMs: number = DEFAULT_CLOCK_SKEW_TOLERANCE_MS
): boolean {
  if (record.isExpired === true) return true;
  if (record.expiresAt == null) return false;
  const expiresUtc = normalizeToUtcMs(record.expiresAt);
  if (expiresUtc == null) return false;

  // Monotonic high-water mark: if time ever reached or passed expiresAt,
  // moving the clock backwards must not resurrect the record.
  if (record.maxObservedTime != null) {
    const maxObservedUtc = normalizeToUtcMs(record.maxObservedTime);
    if (maxObservedUtc !== null && maxObservedUtc >= expiresUtc) {
      return true;
    }
  }

  // If restoredAt was past the expiry, it was already expired at restore time.
  if (record.restoredAt != null) {
    const restoredUtc = normalizeToUtcMs(record.restoredAt);
    if (restoredUtc !== null && restoredUtc >= expiresUtc) {
      return true;
    }
  }

  return nowUtc >= expiresUtc;
}

/**
 * Validates a recovery or restore manifest against clock skew, timezone offsets,
 * negative elapsed time, and expired data revival.
 */
export function validateClockAndExpiryInvariants(
  manifest: RestoreManifest,
  options?: ClockSkewOptions
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  const nowDate = options?.now ? options.now() : new Date();
  const nowUtc = nowDate.getTime();
  const tolerance = options?.toleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;

  const backupUtc = normalizeToUtcMs(manifest.backupTimestamp);
  const restoredUtc = normalizeToUtcMs(manifest.restoredAt);

  if (backupUtc === null) {
    violations.push({
      type: 'inconsistent-state',
      severity: 'critical',
      message: `Invalid backup timestamp format in restore manifest "${manifest.restoreId}"`,
      details: { backupTimestamp: manifest.backupTimestamp },
      affectedRecords: [manifest.restoreId]
    });
    return violations;
  }

  if (restoredUtc === null) {
    violations.push({
      type: 'inconsistent-state',
      severity: 'critical',
      message: `Invalid restoredAt format in restore manifest "${manifest.restoreId}"`,
      details: { restoredAt: manifest.restoredAt },
      affectedRecords: [manifest.restoreId]
    });
    return violations;
  }

  // 1. Negative elapsed time check (restore before backup existed)
  if (restoredUtc < backupUtc) {
    violations.push({
      type: 'negative-elapsed-time',
      severity: 'critical',
      message: `Restore timestamp (${new Date(restoredUtc).toISOString()}) is earlier than backup timestamp (${new Date(backupUtc).toISOString()})`,
      details: {
        restoreId: manifest.restoreId,
        backupUtc,
        restoredUtc,
        negativeElapsedMs: backupUtc - restoredUtc
      },
      affectedRecords: [manifest.restoreId]
    });
  }

  // 2. Future clock skew checks
  if (backupUtc > nowUtc + tolerance) {
    violations.push({
      type: 'clock-skew',
      severity: 'critical',
      message: `Backup timestamp is in the future beyond acceptable clock tolerance (${tolerance}ms)`,
      details: {
        restoreId: manifest.restoreId,
        backupUtc,
        nowUtc,
        driftMs: backupUtc - nowUtc,
        toleranceMs: tolerance
      },
      affectedRecords: [manifest.restoreId]
    });
  }

  if (restoredUtc > nowUtc + tolerance) {
    violations.push({
      type: 'clock-skew',
      severity: 'critical',
      message: `Restore timestamp is in the future beyond acceptable clock tolerance (${tolerance}ms)`,
      details: {
        restoreId: manifest.restoreId,
        restoredUtc,
        nowUtc,
        driftMs: restoredUtc - nowUtc,
        toleranceMs: tolerance
      },
      affectedRecords: [manifest.restoreId]
    });
  }

  // 3. Timezone offset sanity check
  if (manifest.timezoneOffsetMinutes !== undefined) {
    if (manifest.timezoneOffsetMinutes < -720 || manifest.timezoneOffsetMinutes > 840) {
      violations.push({
        type: 'inconsistent-state',
        severity: 'warning',
        message: `Timezone offset out of standard bounds (-720 to +840 mins): ${manifest.timezoneOffsetMinutes}`,
        details: { timezoneOffsetMinutes: manifest.timezoneOffsetMinutes },
        affectedRecords: [manifest.restoreId]
      });
    }
  }

  // 4. Record-level expiry and causality invariants
  for (const record of manifest.records) {
    const createdUtc = normalizeToUtcMs(record.createdAt);
    if (createdUtc !== null && createdUtc > backupUtc + tolerance) {
      violations.push({
        type: 'inconsistent-state',
        severity: 'critical',
        message: `Record ${record.id} createdAt is later than backup timestamp`,
        details: { recordId: record.id, createdUtc, backupUtc },
        affectedRecords: [record.id]
      });
    }

    if (record.expiresAt != null) {
      const expiresUtc = normalizeToUtcMs(record.expiresAt);
      if (expiresUtc !== null) {
        // If expired prior to backup, it must never be restored as active
        if (expiresUtc <= backupUtc) {
          violations.push({
            type: 'expired-record',
            severity: 'critical',
            message: `Record ${record.id} was already expired at backup time and cannot be restored as active data`,
            details: { recordId: record.id, expiresUtc, backupUtc },
            affectedRecords: [record.id]
          });
        } else if (
          record.maxObservedTime != null &&
          normalizeToUtcMs(record.maxObservedTime)! >= expiresUtc &&
          nowUtc < expiresUtc
        ) {
          // Backward-moving client clock attempted resurrection
          violations.push({
            type: 'expired-record',
            severity: 'critical',
            message: `Record ${record.id} expired at previous high-water mark (${new Date(record.maxObservedTime).toISOString()}); backwards client clock cannot revive expired data`,
            details: {
              recordId: record.id,
              nowUtc,
              expiresUtc,
              maxObservedTime: record.maxObservedTime
            },
            affectedRecords: [record.id]
          });
        } else if (isExpiredConservatively(record, nowUtc, tolerance)) {
          violations.push({
            type: 'expired-record',
            severity: 'warning',
            message: `Record ${record.id} is expired under current conservative evaluation`,
            details: { recordId: record.id, expiresUtc, nowUtc },
            affectedRecords: [record.id]
          });
        }
      }
    }
  }

  return violations;
}

class RecoveryValidator {
  private checks: InvariantCheck[] = [];

  registerCheck(check: InvariantCheck): void {
    this.checks.push(check);
  }

  async validate(options?: ValidationOptions): Promise<ValidationResult> {
    const timestamp = options?.now ? options.now() : new Date();
    const violations: InvariantViolation[] = [];
    let passedChecks = 0;
    let failedChecks = 0;

    for (const check of this.checks) {
      try {
        const checkViolations = await check.check(options);
        
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

validator.registerCheck({
  name: 'clock-skew-and-expiry-boundaries',
  description: 'Validate recovery manifests for clock skew, negative elapsed time, DST/timezone boundaries, and expired data revival',
  check: async (options) => {
    if (!options?.manifests || options.manifests.length === 0) {
      return [];
    }
    const violations: InvariantViolation[] = [];
    for (const manifest of options.manifests) {
      violations.push(...validateClockAndExpiryInvariants(manifest, options));
    }
    return violations;
  }
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
