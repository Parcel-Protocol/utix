# Soroban Contract Invocation Decoder

Decodes Soroban smart contract invocations and ScVal value trees into human-readable structures with dry-run RPC simulation.

## How it works

This tool parses `ScVal` XDR trees recursively (up to depth 10) and simulates footprint/resource usage via read-only RPC endpoints.

## Safety

This tool operates strictly in read-only mode and never invokes `sendTransaction` or requests private keys.
