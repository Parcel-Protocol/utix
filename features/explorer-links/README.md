# Multi-Explorer Link Generator

Paste any Stellar identifier and get direct links on every major explorer.

## Purpose

Every explorer uses a different URL shape for the same data. Building the right link by hand for the right network is a small tax paid many times a day.

This tool classifies the identifier and generates links for all major explorers simultaneously.

## Input

Any Stellar identifier:
- Account address (G...)
- Muxed account (M...)
- Transaction hash (64 hex characters)
- Ledger sequence (numeric)
- Asset (code:issuer format)
- Contract (C...)

Network selection (mainnet or testnet).

## Output

Direct links to view the identifier on:
- Stellar Expert
- Stellar Chain
- SteExp
- Network-specific variants (testnet prefixes)

## Classification

The tool identifies the input by format:
- **Account**: G-prefix, 56 characters
- **Muxed Account**: M-prefix, 56+ characters
- **Contract**: C-prefix, 56 characters
- **Transaction**: 64 hex characters
- **Ledger**: Numeric, up to 10 digits
- **Asset**: `CODE:ISSUER` format where ISSUER is a valid account

## Local Only

All classification and link generation happens in the browser. No data is transmitted.
