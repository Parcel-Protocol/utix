# Dependency degradation matrix and fallback behavior

Source: `core/dependencies/degradation.ts` (#340). Tests: `core/dependencies/__tests__/degradation.test.ts`.

For user-facing publication, pass a tracker snapshot to
`componentFromDependencyState` in `core/status/feed.ts` and supply an explicit
public component id and name. The status feed maps healthy/degraded/down to
operational/degraded/major outage and strips the failure mode, counters, and
override metadata. Without the public mapping, the component is internal and
is omitted. The existing `1.0.0` feed shape is unchanged; consumers receive
ordinary component status changes through `/api/status`.

Utix depends on services it does not run. The matrix records, for each one, how it fails, how hard the app retries, what it falls back to, and what the user is told. `createDegradationTracker().callWithFallback(id, primary, { fallback })` is the single code path that applies the table.

## Matrix

| Dependency | Failure modes | Attempts (base backoff) | Fallback | Critical |
|---|---|---|---|---|
| `horizon` | timeout, rate limited, unavailable, invalid response | 3 (250 ms) | `cached_read`: last good response | yes |
| `soroban_rpc` | timeout, rate limited, unavailable, invalid response | 3 (250 ms) | `read_only`: inspect and decode, no simulation | yes |
| `freighter` | timeout, unavailable | 1 | `read_only`: paste an address instead of connecting | no |
| `friendbot` | timeout, rate limited, unavailable | 2 (1 s) | `feature_off`: hide the fund button and explain | no |
| `stellar_toml` | timeout, unavailable, invalid response | 2 (500 ms) | `none`: fail with a clear message | no |
| `browser_storage` | unavailable | 1 | `in_memory`: works for this tab, nothing persisted | no |

Every entry carries a user-facing `userMessage`. It never contains hosts, status codes or upstream error text.

## Behavior

1. **Retry.** The primary is tried up to the entry's attempt count, with exponential backoff (`base × 2^(n-1)`). An `invalid_response` (an HTTP 4xx other than 429, or unparsable JSON) is not retried: the upstream answered, and asking again returns the same thing.
2. **Health.** Each exhausted call counts as one failure. One or more consecutive failures mean `degraded`; reaching the threshold (default 3) means `down`. Any success resets the count to `healthy`.
3. **Circuit.** While a dependency is `down`, the primary is skipped and the call goes straight to the fallback. After the recovery window (default 30 s) one probe attempt is allowed: success closes the circuit, failure keeps it open for another window.
4. **Fallback.** It runs only when the strategy is not `none` and the caller supplied one. The result is marked `source: "fallback"` with the `userMessage` to show.
5. **Failure.** With no usable fallback, the call returns `dependency_unavailable` (or `fallback_failed` if the substitute threw), with `{ dependency, failureMode, strategy, userMessage }` as detail.

`classifyFailure` maps thrown values to failure modes from `name` and `status` only. It never reads error messages, so nothing upstream-controlled decides behavior.

## Operator overrides

`override(id, level, auth, until?)` and `clearOverride(id, auth)` need `admin:health` (`maintainer` or `service`). Others get `override_forbidden`.

- Forcing `down` skips the primary during a known provider incident, so users get the fallback immediately instead of waiting through retries.
- Forcing `healthy` keeps calling a dependency the tracker believes is down, for example after the provider confirms recovery.
- A timed override (`until`, epoch ms) lifts itself once that time passes, so a forgotten override recovers by itself. An `until` that is not in the future is refused with `invalid_override`.

## Edge cases and recovery

- **No state to migrate.** The tracker is in-memory per instance, so a reload starts every dependency `healthy`. That is safe because the first failed call re-learns the state.
- **Thundering herd.** The open circuit and the single half-open probe stop retries from piling onto a provider that is already down.
- **Stale cache.** `cached_read` fallbacks must be labelled. The returned `userMessage` says the data may be out of date; callers must show it.
- **Public status recovery.** Publish a new tracker snapshot after each dependency result. Success resets the tracker to healthy and therefore clears the public degraded component on the next feed build; if a mapping is removed during recovery, the component becomes internal and disappears. Never put upstream diagnostics in the public component name.
- **Adding a dependency.** Add the id to `DEPENDENCY_IDS` and an entry to the matrix. The matrix test fails until every id has a retry budget, a fallback and a safe message.

## Recovery UX

`core/status/DependencyStatusBanner.tsx` is mounted by the shared app shell. It
reads `/api/dependencies`, displays only the public component names and a
generic fallback message if the status endpoint itself is unavailable, and
allows users to request a fresh check. It stays hidden while all components are
operational. The banner does not render probe errors, endpoint URLs, or status
codes.

`core/dependencies/DependencyRecoveryNotice.tsx` remains available to individual
tools that need an action-specific retry. It disables retry while recovery is
in progress, uses `role="status"`, and exposes the dependency as data only for
automation. Callers must pass the matrix's safe `userMessage`; upstream
exception text and status codes must not be rendered.
