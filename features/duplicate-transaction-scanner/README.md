# Duplicate Transaction Scanner

Detect duplicate Stellar transactions by computing deterministic fingerprints and review candidate groups with an audited confirm/dismiss/defer workflow.

## How it works

When transactions are submitted to Stellar (e.g. automated disbursements, retried payments, batch operations), transient network failures or wallet timeouts can lead to duplicate submissions with different transaction hashes or sequences.

This tool accepts a batch of up to 20 transaction hashes, fetches their details from Horizon, extracts operations, and computes a canonical SHA-256 fingerprint from:
- `sourceAccount`
- Sorted `operationTypes`
- `feeCharged`
- `memoType` and `memo`
- Time bucket window (300 seconds)

Transactions sharing the exact same fingerprint are grouped into `CandidateGroup` entries. The reviewer can inspect the transactions side-by-side, view an automatically derived `MergePlan`, and execute `confirm`, `dismiss`, or `defer` actions with an append-only audit trail and rollback capabilities.

## Threat boundary

- **Data sources:** a multi-line textarea of transaction hashes and network selection. Persisted review decisions in localStorage under `utix:dup-scan:v1:groups`.
- **Outbound requests:** read-only `GET {horizon}/transactions/{hash}` and `GET {horizon}/transactions/{hash}/operations?limit=50` to `horizon-testnet.stellar.org` or `horizon.stellar.org`.
- **Cannot sign or submit:** input validation accepts only 64-hex-character hashes, rejecting secret seeds and private keys. The slice never imports secret key material and never signs or submits transactions to Horizon or Soroban RPC.

