# Soroban Resource Fee Estimator

Calculate exact resource fees for Soroban transactions with itemized breakdown.

## Purpose

A Soroban transaction fails with `tx_insufficient_fee` and gives no breakdown. Resource fees are computed from multiple independently priced dimensions. This tool identifies which component dominates and whether the declared fee is sufficient.

## Input

A transaction envelope (base64-encoded) containing a Soroban invocation with resource declarations.

Network selection (mainnet or testnet).

## Output

For each resource dimension:
- Resource count (CPU instructions, memory bytes, ledger read/write bytes, rent bytes)
- Unit price from current network pricing
- Total fee for that dimension

Plus:
- Total estimated fee
- Declared fee from envelope
- Comparison (sufficient/insufficient)
- Identification of dominant cost component

## Components

1. **CPU Instructions**: Computational cost
2. **Memory Bytes**: Memory usage during execution
3. **Ledger Read Bytes**: Cost of reading ledger entries
4. **Ledger Write Bytes**: Cost of writing ledger entries
5. **Ledger Rent Bytes**: Long-term storage rental cost

## Computation

All arithmetic uses BigInt to avoid precision loss in fee calculations. Fees are stroops (smallest Stellar unit).

## Pricing

Current network pricing fetched from Soroban RPC:
- `getFeeStats` for per-resource unit prices
- Falls back to conservative defaults if unavailable

## Error Codes

- `empty_input`: No envelope provided
- `invalid_base64`: Input is not valid base64
- `invalid_xdr`: Valid base64 but not a transaction envelope
- `not_soroban`: Envelope has no Soroban invocation
- `no_resources`: Soroban invocation declares no resources
- `pricing_unavailable`: Current pricing not available
- `rpc_error`: RPC endpoint error
- `request_failed`: Network connection error
