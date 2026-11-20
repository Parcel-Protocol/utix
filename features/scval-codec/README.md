# ScVal Encoder & Decoder

Converts tagged JSON to base64 Soroban ScVal and decodes base64 ScVal back to
readable tagged JSON. Conversion is local and preserves large integers as
decimal strings.

## How it works

The Stellar SDK XDR codec is the only data source. Results include the base64
ScVal and a JSON representation of nested vectors, maps, addresses, and scalar
values.

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

The tool never asks for a secret key.

## Threat boundary

<!-- Required by docs/FEATURE_CONTRACT.md rule 15; verify:features fails while a TODO remains. -->

- **Data sources:** The pasted JSON or base64 ScVal and the bundled Stellar SDK.
- **Outbound requests:** None — encoding and decoding run entirely in the browser.
- **Cannot sign or submit:** The codec accepts value data only and calls no wallet, signing, or transaction submission API.
