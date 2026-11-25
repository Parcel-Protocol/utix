# Fuzz Coverage for Malformed Payloads and Boundary Values (#268)

`core/__tests__/fuzz.test.ts` drives core boundaries with generated input. A
seeded PRNG (mulberry32) generates the input, so every failure reproduces exactly:

```bash
npm test -- core/__tests__/fuzz                      # default seed
FUZZ_SEED=12345 npm test -- core/__tests__/fuzz      # explore another seed
```

Each property states what must hold for every input. A failing assertion
names the seed and the input.

| Target | Property |
| :--- | :--- |
| `parseAmount` / `amountToStroops` / `stroopsToAmount` | Every int64 stroop value round-trips exactly. Amounts are signed int64 scaled by 10⁷, so the bounds are `922337203685.4775807` and `-922337203685.4775808`; one stroop past either is `out_of_range`, and an eighth decimal is `too_many_decimals`. Arbitrary input returns a declared `AmountParseError` and never throws. |
| `parseJsonRpcResponse` | Any value, including cycles, BigInt, symbols and prototype keys, yields a JSON-RPC 2.0 envelope with exactly one of `result`/`error`. `error.code` is always an integer (§5.1), and a success always carries the expected id. |
| `requestDigest` / `canonicalize` / `IdempotencyStore.begin` | Any payload digests deterministically. A key is either claimed or rejected with a declared code, and an immediate duplicate is `idempotency_in_flight`. |
| `hasPermission` / `hasAnyPermission` / `hasAllPermissions` | An unknown role, including `toString` and `__proto__`, is denied and never throws. Known roles keep their exact grants. |

## Defects found and fixed

| Defect | Impact | Fix |
| :--- | :--- | :--- |
| `hasPermission` threw `TypeError` for any role outside the table | A mistyped `UTIX_USER_ROLE` crashed every permission check, and prototype keys resolved to functions | `Object.hasOwn` guard: unknown roles are denied |
| `canonicalize` threw on `BigInt` and overflowed the stack on cycles | `IdempotencyStore.begin` threw instead of returning a `Result` | BigInt → `10n`; a back-reference → `#cycle` |
| `parseJsonRpcResponse` accepted `NaN` or fractional error codes | A malformed error envelope passed as valid | Error code must satisfy `Number.isInteger` |

## Compatibility

All three fixes only change inputs that used to throw or that the spec forbids:

- Every input `JSON.stringify` accepted keeps its exact canonical form, so
  persisted idempotency digests stay valid. `#cycle` and the `n` suffix are not
  valid JSON, so they cannot collide with an existing digest.
- Every role in `ROLE_PERMISSIONS` keeps its exact grants.
- A valid JSON-RPC error has an integer code, so no valid envelope changes.

No migration is needed. To roll back, revert the three one-function changes.
The fuzz suite then fails, which shows exactly which guard was removed.

## Boundary Property Tests (#359)

`core/__tests__/boundary-properties.test.ts` states properties over numeric and
timestamp *boundaries*, using the dependency-free harness in
`core/testing/property.ts`:

- `forAll(arbitrary, property)` / `forAllAsync` first check every boundary the
  arbitrary declares (`min`, `min + 1`, −1, 0, 1, `max − 1`, `max`, and for
  `anyNumber` NaN, ±Infinity, −0, fractions and unsafe integers), then
  `runs` seeded random draws (default 500);
- a failure names the property, the seed, the run and the counterexample;
- `PROPERTY_SEED=<seed> npm test -- core/__tests__/boundary-properties`
  reproduces it (`FUZZ_SEED` is honoured too, and the #268 fuzz suite now draws
  from the same PRNG).

| Path | Target | Property |
| :--- | :--- | :--- |
| Normal | `formatUnixSeconds` | Never throws. Every integer second within ±8.64e12 (the Date range) formats as a UTC date; one second past it, and any non-integer, is shown as given |
| Normal | `formatDateTime` | Never renders `Invalid Date`; an unparseable value is shown as given |
| Normal | `parseRetryAfter` | Delay-seconds and HTTP-dates are read exactly, a past date is 0, and the result is always finite and ≥ 0 or `undefined` |
| Failure | Bounded cache TTL | An entry is served iff `age ≤ ttl`, for TTLs up to 2⁴⁰ ms |
| Failure | Bounded cache ledger guard | Over the full uint32 range a write never moves a key's ledger sequence backwards; any non-integer, negative or unsafe sequence is refused up front |
| Failure | Stale detector | `ageMs` is always finite and ≥ 0; an unreadable timestamp is never clean; drift equal to the tolerance is clean and one ledger more is `ledger_drift` |
| Retry | `retryDelayMs` | Always in `[0, maxDelayMs]`, never shrinks as attempts grow, for any `Retry-After` |
| Retry | `computeRepairRetryBackoffMs` | Always finite and in `[0, maxMs]`, never below the base for a real attempt |
| Retry | Probe step | Succeeds iff transient failures < `maxAttempts`; attempts and sleeps are exact |
| Authorization | Cache `clear` / `evictStale` | Succeed for exactly the roles holding `admin:recovery`, including `__proto__` and `toString` as roles; a refusal changes nothing |
| Authorization | `runJourney` / workflow monitor | Run for exactly the roles holding `admin:health`; a refusal makes no request |

### Defects found and fixed

| Defect | Impact | Fix |
| :--- | :--- | :--- |
| `formatUnixSeconds` threw on a fractional, NaN or non-numeric value (`BigInt(1.5)`) | A malformed time bound crashed the panel rendering it | Non-integers are shown as given |
| `parseRetryAfter("999…")` returned `Infinity` | Downstream arithmetic on the delay could produce NaN | Capped at `Number.MAX_SAFE_INTEGER` (then by `maxDelayMs`) |
| `StaleProjectionDetector.inspect` treated an unreadable `cachedAt` as fresh (`NaN > ttl` is false) | A corrupt entry was never flagged | Reported as `ttl_expired` with an explanatory detail |
| `computeRepairRetryBackoffMs(NaN)` was `NaN`; a negative attempt gave less than the base delay | A retry scheduler could spin or wait `NaN` ms | Attempt clamped to a whole number ≥ 0 |
| Bounded cache accepted `ledgerSequence: NaN` | The key's stale-write guard was disabled (`x < NaN` is false) | `RangeError`, like an invalid TTL |

### Compatibility

Each fix only changes inputs that used to throw, return a non-finite number or
bypass a guard. Every valid input keeps its exact output, so no migration is
needed. To roll back, revert the individual guard. The property suite then
fails with the counterexample that shows what was lost.
