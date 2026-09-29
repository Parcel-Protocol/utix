# Soroban Authorization Entry Inspector

Decode authorization entries attached to a Soroban invocation and render the authorization tree.

## Purpose

Soroban authorization is a tree, not a signature. When a user is asked to sign an invocation, they cannot currently see which sub-calls that signature also authorizes — which is precisely where a malicious contract hides.

This tool makes the authorization tree visible:
- Who must sign (source account or address signer)
- For which sub-invocation (contract and function)
- Under which nonce and expiry (for address signers)

## Input

A transaction envelope (base64-encoded) containing a Soroban invocation with authorization entries.

## Output

An authorization tree for each entry, showing:
- Credential type (source account or address signer)
- Contract address and function name
- Function arguments (decoded as ScVal tree)
- Nonce and expiry ledger (for address signers)
- Flag for sub-invocations not obviously implied by the top-level call

## Error Codes

- `empty_input`: No input provided
- `invalid_base64`: Input is not valid base64
- `invalid_xdr`: Valid base64 that is not a transaction envelope
- `not_soroban`: Envelope contains no Soroban invocation
- `no_authorization`: Invocation declares no authorization entries
- `auth_unreadable`: Authorization entry cannot be decoded

## Security Note

This tool operates locally only. No envelope or authorization data is transmitted. No secret keys are accepted, displayed, stored, or transmitted.
