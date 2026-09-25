#!/usr/bin/env node

/**
 * Per-feature bundle size budget enforcement
 * 
 * Analyzes Next.js build output to compute per-feature-slice bundle sizes
 * and enforces documented budgets.
 * 
 * This prevents any single feature from quietly pulling in heavy dependencies
 * that bloat its lazy-loaded chunk.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const BASELINE_PATH = join(ROOT, 'bundle-baseline.json');
const BUILD_MANIFEST_PATH = join(ROOT, '.next/build-manifest.json');

const DEFAULT_BUDGET_KB = 150;

const FEATURE_BUDGETS = {
  'address-validator': 120,
  'balance-viewer': 150,
  'trustline-checker': 100,
  'payment-qr': 180,
  'transaction-lookup': 140,
  'freighter-connect': 80,
  'testnet-faucet': 90,
};

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return {};
  }
  
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (error) {
    console.warn(`Warning: Could not load baseline from ${BASELINE_PATH}`);
    return {};
  }
}

function loadBuildManifest() {
  if (!existsSync(BUILD_MANIFEST_PATH)) {
    throw new Error(`Build manifest not found at ${BUILD_MANIFEST_PATH}. Run 'npm run build' first.`);
  }
  
  return JSON.parse(readFileSync(BUILD_MANIFEST_PATH, 'utf-8'));
}

function computeChunkSize(chunkPath) {
  const fullPath = join(ROOT, '.next', chunkPath);
  
  if (!existsSync(fullPath)) {
    return 0;
  }
  
  const stats = readFileSync(fullPath);
  return stats.length;
}

function analyzeFeatureSlices(manifest) {
  const featureSizes = {};
  
  for (const [route, chunks] of Object.entries(manifest.pages || {})) {
    const match = route.match(/^\/tools\/\[slug\]$/);
    if (!match) continue;
    
    let totalSize = 0;
    const chunkDetails = [];
    
    for (const chunk of chunks) {
      if (chunk.includes('/_app') || chunk.includes('/_error')) {
        continue;
      }
      
      if (chunk.includes('/webpack') || chunk.includes('/node_modules/')) {
        continue;
      }
      
      const size = computeChunkSize(chunk);
      if (size > 0) {
        totalSize += size;
        chunkDetails.push({ path: chunk, size });
      }
    }
    
    featureSizes[route] = {
      totalSize,
      chunks: chunkDetails,
    };
  }
  
  const dynamicChunks = manifest.sortedPages?.filter(page => 
    page.startsWith('dynamic/') && page.includes('features/')
  ) || [];
  
  for (const chunk of dynamicChunks) {
    const match = chunk.match(/features\/([^\/]+)/);
    if (!match) continue;
    
    const featureName = match[1];
    const size = computeChunkSize(`static/chunks/${chunk}.js`);
    
    if (size > 0) {
      if (!featureSizes[featureName]) {
        featureSizes[featureName] = {
          totalSize: 0,
          chunks: [],
        };
      }
      
      featureSizes[featureName].totalSize += size;
      featureSizes[featureName].chunks.push({
        path: `static/chunks/${chunk}.js`,
        size,
      });
    }
  }
  
  return featureSizes;
}

function checkBudgets(featureSizes, baseline) {
  const results = [];
  let hasViolations = false;
  
  for (const [feature, data] of Object.entries(featureSizes)) {
    const sizeKB = Math.round(data.totalSize / 1024);
    const budgetKB = FEATURE_BUDGETS[feature] || DEFAULT_BUDGET_KB;
    const baselineSizeKB = baseline[feature] ? Math.round(baseline[feature].totalSize / 1024) : 0;
    const delta = sizeKB - baselineSizeKB;
    
    const status = sizeKB > budgetKB ? 'EXCEEDED' : 'OK';
    const withinBudget = sizeKB <= budgetKB;
    
    if (!withinBudget) {
      hasViolations = true;
    }
    
    results.push({
      feature,
      sizeKB,
      budgetKB,
      baselineSizeKB,
      delta,
      status,
      withinBudget,
      chunks: data.chunks,
    });
  }
  
  return { results, hasViolations };
}

function formatReport(results, hasViolations) {
  const lines = [];
  
  lines.push('='.repeat(80));
  lines.push('BUNDLE SIZE BUDGET REPORT');
  lines.push('='.repeat(80));
  lines.push('');
  
  if (results.length === 0) {
    lines.push('No feature slices detected in build output.');
    lines.push('This is normal for a fresh build without features.');
  } else {
    lines.push('Feature'.padEnd(30) + 'Size'.padEnd(15) + 'Budget'.padEnd(15) + 'Status');
    lines.push('-'.repeat(80));
    
    for (const result of results) {
      const featureName = result.feature.padEnd(30);
      const size = `${result.sizeKB} KB`.padEnd(15);
      const budget = `${result.budgetKB} KB`.padEnd(15);
      const status = result.status;
      
      lines.push(`${featureName}${size}${budget}${status}`);
      
      if (result.delta !== 0 && result.baselineSizeKB > 0) {
        const deltaStr = result.delta > 0 ? `+${result.delta}` : `${result.delta}`;
        lines.push(`  (${deltaStr} KB from baseline)`);
      }
    }
  }
  
  lines.push('');
  lines.push('='.repeat(80));
  
  if (hasViolations) {
    lines.push('');
    lines.push('BUDGET VIOLATIONS DETECTED');
    lines.push('');
    lines.push('To resolve:');
    lines.push('  1. Review dependencies added to the feature');
    lines.push('  2. Consider code-splitting or lazy loading');
    lines.push('  3. Request budget increase if justified (update FEATURE_BUDGETS)');
    lines.push('');
  }
  
  return lines.join('\n');
}

function saveBaseline(featureSizes) {
  const baseline = {};
  
  for (const [feature, data] of Object.entries(featureSizes)) {
    baseline[feature] = {
      totalSize: data.totalSize,
      sizeKB: Math.round(data.totalSize / 1024),
      timestamp: new Date().toISOString(),
    };
  }
  
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline saved to ${BASELINE_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const jsonOutput = args.includes('--json');
  
  try {
    const baseline = loadBaseline();
    const manifest = loadBuildManifest();
    const featureSizes = analyzeFeatureSlices(manifest);
    const { results, hasViolations } = checkBudgets(featureSizes, baseline);
    
    if (jsonOutput) {
      console.log(JSON.stringify({ results, hasViolations }, null, 2));
    } else {
      console.log(formatReport(results, hasViolations));
    }
    
    if (updateBaseline) {
      saveBaseline(featureSizes);
    }
    
    if (hasViolations && !updateBaseline) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Bundle budget check failed:');
    console.error(error.message);
    process.exit(2);
  }
}

main();
