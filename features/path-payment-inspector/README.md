# Path Payment and DEX Offer Inspector

This tool reads open offers for an account and traces candidate strict-send or
strict-receive paths between two assets. Prices are shown as exact ratios and
decimal strings, and each path hop identifies an order book or liquidity pool.

## How it works

Offers come from Horizon's `/accounts/{account}/offers` endpoint. Path queries
use `/paths/strict-send` or `/paths/strict-receive`; an empty embedded record
list is a valid no-route result, not a calculation error. Amounts remain
decimal strings throughout, and rational prices use `BigInt` formatting.

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

The tool is read-only and never asks for, accepts, or transmits a secret key.
