#!/usr/bin/env node

/**
 * Disaster recovery validation command
 * 
 * Read-only validation of core domain invariants.
 * Run after restore or migration to verify data integrity.
 * 
 * Usage:
 *   npm run recovery:validate
 *   node scripts/validate-recovery.mjs
 *   node scripts/validate-recovery.mjs --json
 */

import { validator, formatValidationReport } from '../core/recovery/validator.ts';

async function main() {
  const isJson = process.argv.includes('--json');
  
  try {
    console.log('Running disaster recovery validation...\n');
    
    const result = await validator.validate();
    
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatValidationReport(result));
    }
    
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error('Validation failed with error:');
    console.error(error);
    process.exit(2);
  }
}

main();
