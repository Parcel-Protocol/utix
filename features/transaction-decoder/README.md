# Transaction Decoder & Simulator

Decodes multi-operation Stellar transaction XDR envelopes into per-operation breakdowns with static effect preview.

## How it works

This tool decodes `TransactionEnvelope` (V0, V1, FeeBump) XDRs locally without sending signing requests or submitting transactions.
Static effect analysis detects cancel offers, sponsorship wrappers, and muxed account destinations.

## Safety

This tool operates strictly in read-only mode and never requests, stores, or uses private keys.
