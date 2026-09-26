# Testnet Faucet

Funds a Stellar **testnet** account through Friendbot, and explains precisely
why a request was refused.

## How it works

Friendbot returns HTTP 400 both for "this account already exists" and for a
genuinely malformed request, so the status code alone is not enough.
`classifyFriendbotResponse` reads the problem document to separate them, which
is the difference between a useful message and a dead end — an account that
already exists is not an error the user can fix by retrying.

| Response | Code | Retried? |
| --- | --- | --- |
| 400, `detail` "account already funded to starting balance" or "createAccountAlreadyExist (…)" | `already_funded` | No |
| 400, `extras.invalid_field: "addr"` | `invalid_address` | No |
| 429 (from the rate limiter in front of Friendbot) | `rate_limited` | Yes, with backoff |
| 408, 504, 524, or no answer within `FRIENDBOT_TIMEOUT_MS` | `timeout` | No |
| Any other 5xx, or the request never reaching Friendbot | `friendbot_unavailable` | No |

## Rate limiting and backoff

Utix has no backend, so there is no server-side queue. The browser waits
instead: `fundWithBackoff` retries **only** a rate-limited attempt, using
exponential backoff with full jitter (a random wait below a ceiling that
doubles from 1 s up to 30 s) so many limited clients do not retry in lockstep.
It stops after `RETRY_POLICY.maxAttempts` requests in total. A `Retry-After`
header is a minimum wait; if it asks for longer than the 30 s cap, Utix stops
at once and says how long Friendbot asked clients to wait.

While a retry is pending the form stays disabled, the panel says which attempt
is next and when, and **Stop retrying** cancels it.

A timeout is deliberately not retried. Friendbot may have submitted the
funding transaction even though the answer never arrived, so the message asks
the user to check the account first.

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
