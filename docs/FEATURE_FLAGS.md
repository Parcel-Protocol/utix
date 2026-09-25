# Feature flags

Utix feature flags are typed in `core/feature-flags/flags.ts` and read from
environment variables named `UTIX_FLAG_<flag>`. A missing variable always uses
the flag's safer default. The flag is evaluated in the action's domain logic,
so a disabled rollout cannot be bypassed by changing client UI state.

## Current flag

`UTIX_FLAG_detailedFriendbotClassification` controls the newer response-body
classification for Friendbot's HTTP 400 responses. It defaults to `true`,
preserving the existing detailed already-funded behavior while allowing an
operator to disable it during an incident.

## Rollout and rollback

1. Deploy with the variable unset and verify normal faucet requests and
   refusal handling.
2. Compare the rate of `already_funded` and generic refusal results in
   application logs.
3. Disable with `UTIX_FLAG_detailedFriendbotClassification=false` during an
   incident, then restart the affected process.

Do not put secrets in feature-flag values. Flags are operational controls, not
authorization or authentication.