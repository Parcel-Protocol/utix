# Claimable Balance Predicate Builder

Construct, inspect, and export Stellar claimable balance predicates as a visual AST. Previews who can claim and when in plain English, detects unsatisfiable logic, and produces valid base64 XDR.

## How it works

This tool is entirely local and makes zero network requests. It constructs an in-memory Abstract Syntax Tree representing combinations of `unconditional`, `beforeAbsoluteTime`, `beforeRelativeTime`, `and`, `or`, and `not` conditions. It parses and validates them against Stellar's `xdr.ClaimPredicate` specification, rendering both human-readable explanations and base64 XDR.

## Files

| Path | Responsibility |
| --- | --- |
| `manifest.ts` | Registry metadata |
| `schema.ts` | Input parsing and validation |
| `lib/` | Predicate AST, XDR encoder/decoder, plain language explainer, and unsatisfiability analyzer |
| `hooks/` | React state machine for builder operations |
| `components/` | Visual tree node editor, form, result card, and empty states |
| `__tests__/` | Unit, component, runtime contract, and accessibility tests |
| `fixtures/` | Deterministic sample predicate trees and XDR fixtures |
| `msw/` | Offline request mock handlers |

## Safety

This tool operates completely client-side. It never accepts, stores, or transmits any secret keys or sensitive credentials.
