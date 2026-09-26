# Testnet Faucet

Funds a Stellar **testnet** account through Friendbot, and explains precisely
why a request was refused.

## How it works

Friendbot returns HTTP 400 both for "this account already exists" and for a
genuinely malformed request, so the status code alone is not enough.
`classifyFriendbotResponse` inspects the body to separate the two, which is the
difference between a useful message and a dead end — an account that already
exists is not an error the user can fix by retrying.

A success whose body cannot be parsed is still a success: the account was
funded regardless of what came back, so the result is returned without a
transaction hash rather than as a failure.

There is deliberately **no mainnet path**. The manifest declares
`networks: ["testnet"]`, and selecting mainnet in the header shows a warning
instead of changing what the tool does — Friendbot simply does not exist there,
and real XLM is not something a faucet hands out.

## Safety

Funding an account needs only its **public** address. A value starting with `S`
is a secret seed and is rejected by the same checksum rule that rejects any
non-`G` value, before any request is made.

## Accessibility & Focus Management

- **Network Change Focus Transitions**:
  - Selecting Mainnet triggers a prominent warning banner explaining that Friendbot is testnet-only. Focus is automatically moved to the warning banner (`role="status"`, `tabIndex={-1}`) upon switching network during an active session, ensuring screen-reader users are immediately informed that the tool does not operate on mainnet.
  - Switching back to Testnet automatically focuses the primary account address input field so the user can continue their workflow seamlessly.
- **Form State Announcements**:
  - When account funding fails or encounters an existing account, focus shifts to the error status message so the explanation is read aloud by screen-readers.
  - On funding success, focus moves smoothly to the confirmation result container displaying transaction details and block explorer links.
  - Normal typing or state changes do not disrupt active element focus.
