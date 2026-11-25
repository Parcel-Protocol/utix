# Local Contributor Diagnostics Command (#460)

## Overview

The contributor diagnostics command provides local preflight validation of the contributor development environment. It validates Node.js versions, dependencies, environment hygiene, secret key absence, feature registry sync, and boundary isolation.

## CLI Usage

```bash
# Run standard diagnostics locally
npm run diagnostics:contributor
# Or alias
npm run doctor

# Strict mode (warnings treated as failures)
node --loader ./scripts/loader.mjs scripts/contributor-diagnostics.mjs --strict

# Machine-readable JSON output
node --loader ./scripts/loader.mjs scripts/contributor-diagnostics.mjs --json

# Explicit actor authorization
node --loader ./scripts/loader.mjs scripts/contributor-diagnostics.mjs --actor dev-1 --permission diagnostics:run
```

## Acceptance Criteria & Paths

### 1. Normal Path
- Executes 5 diagnostic checks across environment, package integrity, secret leakage, registry status, and feature boundaries.
- Formats an accessible terminal report with status indicators and remediation steps.

### 2. Failure Path
- Strict mode converts any non-blocking warning into an overall `failing` exit code (1).
- Outdated Node.js or missing package-lock returns actionable diagnostic items.

### 3. Retry Path
- Diagnostic options support `maxAttempts` and `retryDelayMs` to absorb transient filesystem or environment jitter.

### 4. Authorization Path
- Gated by `diagnostics:run` permission.
- Unauthorized calls (missing actor or missing permission) fail immediately with an empty checks array, preventing disclosure of internal paths and environment diagnostics.
