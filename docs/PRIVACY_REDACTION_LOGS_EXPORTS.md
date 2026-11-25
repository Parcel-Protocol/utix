# Privacy Redaction Policy for Logs and Exports (#432)

## Overview

Utix processes transactions and account states on the Stellar network. By architectural design, Utix never retains or outputs private key seeds or raw authentication credentials.

`core/privacy/redaction-policy.ts` establishes an enforceable boundary for:
1. **Telemetry & Logs**: Auto-scrubs Stellar secret seeds (`S...`, `M...`), Bearer tokens, cookies, and sensitive object keys prior to sink ingestion.
2. **Data Exports**: Enforces role-based masking (`[MASKED]`) and omission of internal operational fields (latencies, internal review notes) for public/user actors while preserving auditability for maintainers.
3. **Circular & Deep References**: Safely terminates circular objects (`[CIRCULAR]`) and bounds deep structures (`[TRUNCATED_DEPTH]`) to avoid stack overflows or Denial of Service during serialization.

## Redaction Matrix

| Data Classification | Public / Viewer Export | Maintainer Export | Telemetry / Sentry Logs |
| :--- | :--- | :--- | :--- |
| Stellar Secret Seed (`S...`, `M...`) | `[REDACTED]` | `[REDACTED]` | `[REDACTED]` |
| Bearer Tokens / Auth Headers | `[REDACTED]` | `[REDACTED]` | `[REDACTED]` |
| Admin / Diagnostic Notes | `[MASKED]` | Disclosed | `[REDACTED]` |
| Internal Latency / Traces | Omitted | Disclosed | Disclosed |
| Public Stellar Addresses (`G...`, `C...`) | Disclosed | Disclosed | Disclosed |
