# Disaster Recovery Validation

After restore or migration operations, maintainers must validate core domain invariants to ensure data consistency and system integrity.

## Quick Start

```bash
npm run recovery:validate
```

This command runs read-only validation checks and reports any violations found.

## What Gets Validated

The validation script checks for:

1. **Missing records** - Required data that should exist but is absent
2. **Orphaned references** - References pointing to non-existent records
3. **Duplicate records** - Records with identical unique identifiers
4. **Inconsistent state** - Data that violates business rules
5. **Invalid references** - Malformed or incorrect reference data

## Current Checks

### Registry Manifest Consistency
Verifies that all feature manifests are valid, properly structured, and have unique slugs.

### Network Configuration Validity
Ensures all required network endpoints are configured and URLs are well-formed.

## Output Formats

### Human-readable (default)

```bash
npm run recovery:validate
```

Produces a formatted report suitable for reading.

### JSON output

```bash
npm run recovery:validate -- --json
```

Produces machine-readable JSON for integration with monitoring systems.

## Exit Codes

- **0** - All checks passed
- **1** - One or more checks failed
- **2** - Validation script error

## Understanding Violations

### Severity Levels

**Critical**
Must be resolved immediately. Indicates data corruption or serious integrity violation.

**Warning**
Should be investigated but may not require immediate action. Indicates potential issues.

### Violation Types

Each violation includes:
- Type and severity
- Descriptive message
- Relevant details
- List of affected records

## Escalation Process

When validation fails:

1. Review the full report and identify critical violations
2. Document all violations with timestamps and context
3. For critical violations, halt deployment and investigate immediately
4. For warnings, create tracking issues and schedule resolution
5. After fixes, re-run validation before proceeding
6. Keep validation reports for audit trail

## Integration with CI/CD

The validation command can be integrated into deployment pipelines:

```yaml
- name: Validate recovery
  run: npm run recovery:validate
```

The non-zero exit code will fail the pipeline if violations are detected.

## Adding Custom Checks

To add domain-specific validation:

1. Import the validator in `core/recovery/validator.ts`
2. Register your check with `validator.registerCheck()`
3. Implement the check function returning `InvariantViolation[]`
4. Add test coverage in `core/recovery/__tests__/validator.test.ts`

Example:

```typescript
validator.registerCheck({
  name: 'my-custom-check',
  description: 'Validates custom business rule',
  check: async () => {
    const violations: InvariantViolation[] = [];
    
    // Your validation logic here
    
    return violations;
  },
});
```

## Assumptions

- Validation is read-only and never modifies data
- Checks run independently and do not depend on order
- Failed checks do not prevent other checks from running
- Network and file system access may be required for checks
- Validation runs in Node.js environment with full access to core modules

## Maintenance

When the domain model changes:
- Review existing checks for relevance
- Add new checks for new invariants
- Update test fixtures and expectations
- Document any new failure modes
