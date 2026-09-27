# Soroban Simulation Result Explainer

Simulates Soroban transaction envelopes against RPC (`simulateTransaction`) and explains the diagnostic result in plain language: compute resources, fees, state footprint access, authorization requirements, and execution errors.

## How it works

Accepts a base64-encoded Soroban `TransactionEnvelope` XDR or an existing JSON response from `simulateTransaction`. When an envelope is provided, it submits a simulation request to the network's Soroban RPC endpoint without signing or committing the transaction to the ledger. It breaks down CPU instruction and memory budgets against protocol limits, formats resource fees, inspects state footprints, and clarifies error diagnostics.

## Files

| Path | Responsibility |
| --- | --- |
| `manifest.ts` | Registry metadata |
| `schema.ts` | Input parsing and validation |
| `lib/` | RPC simulation caller, resource percentage calculation, and error diagnosis |
| `hooks/` | React state machine for simulation requests |
| `components/` | Input form, simulation diagnostic results, and empty states |
| `__tests__/` | Unit, component, runtime contract, and accessibility tests |
| `fixtures/` | Deterministic simulation response fixtures |
| `msw/` | Request mocks for Soroban RPC simulation endpoints |

## Safety

This tool only simulates transactions against read-only RPC methods. It never accepts, stores, or transmits private or secret keys.
