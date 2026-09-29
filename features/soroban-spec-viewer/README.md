# Soroban Contract Interface Viewer

Read a deployed contract's interface directly from the chain.

## Purpose

Calling a Soroban contract means knowing its interface. Today that means finding the source code or trusting a README. The contract itself carries the answer in its spec entries embedded in the WASM.

This tool surfaces the complete interface:
- Exported functions with argument and return types
- Custom types defined by the contract
- Error codes the contract can raise

## Input

A Soroban contract address (C...) and network selection (mainnet or testnet).

## Output

The contract specification extracted from the WASM on-chain, showing:
- Function signatures with argument names and types
- Custom struct and enum types
- Error codes with descriptions

## Implementation

1. Validates contract address format
2. Fetches contract instance via Soroban RPC `getLedgerEntries`
3. Retrieves WASM code from the chain
4. Extracts spec entries from the WASM `contractspecv0` custom section
5. Decodes and renders the interface

## Error Codes

- `empty_input`: No address provided
- `invalid_address`: Invalid contract address format
- `network_error`: Could not connect to RPC
- `contract_not_found`: Contract does not exist on network
- `spec_not_available`: WASM has no readable spec
- `spec_unreadable`: Spec entries cannot be decoded
- `rpc_error`: RPC endpoint returned an error
