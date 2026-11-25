# SEP-12 KYC Fields

Searches a curated SEP-9 and SEP-12 KYC field reference by exact name, type,
or description. It helps integrations use the standard field names anchors
expect.

## How it works

The reference table is bundled in the feature. Results include the canonical
field name, value type, requiredness, and a short description.

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

- **Data sources:** Search text and the bundled SEP field table.
- **Outbound requests:** None — this is a local reference lookup.
- **Cannot sign or submit:** The feature only filters static metadata and has no wallet or transaction APIs.
