# Testnet Keypair Generator

Generates a disposable Stellar testnet keypair locally in the browser. The
SDK's CSPRNG is used and no network request is made.

## How it works

The result contains a public key and a testnet secret for the current UI
session. Nothing is written to storage or sent to an API.

## Files

| Path | Responsibility |
| --- | --- |
| `manifest.ts` | Registry metadata |
| `schema.ts` | Input parsing and validation |
| `lib/` | Tool logic and error mapping |
| `hooks/` | React state machine |
| `components/` | Form, result, empty and error UI |
| `__tests__/` | Unit, hook, component and accessibility tests |
| `fixtures/` | Deterministic sample data |
| `msw/` | Request mocks |

## Safety

This tool never accepts an existing secret key. Generated credentials are for
testnet development only and must not be reused or committed.

## Threat boundary

<!-- Required by docs/FEATURE_CONTRACT.md rule 15; verify:features fails while a TODO remains. -->

- **Data sources:** Browser CSPRNG only; no user input, storage, Horizon, or RPC data.
- **Outbound requests:** None — key generation runs entirely in the browser.
- **Cannot sign or submit:** The feature only creates display data and never calls a transaction signing or submission API.
