/**
 * Version-negotiation fixtures (issue #149).
 *
 * A payload whose schema version this build does not speak has to be refused
 * *before* a consumer interprets it, and the refusal has to say which of four
 * different situations it is, because the four call for different responses:
 *
 *   missing      — the caller sent no version. A caller bug, not a version
 *                  problem: nothing about the payload is trustworthy.
 *   deprecated   — an older version this build still serves. Not a refusal at
 *                  all: the payload is fine, and the consumer should start
 *                  planning an upgrade.
 *   future       — newer than this build. The payload may mean something this
 *                  build cannot read, so it must be ignored rather than
 *                  half-interpreted.
 *   unsupported  — anything else, including text that is not a version. Nothing
 *                  to fall back to and nothing to retry.
 *
 * These are the shapes the contract boundary must answer for. They are exported
 * as data rather than written inline in the test so the exporter, the docs and
 * the suite all negotiate the same cases: a version added here is a version the
 * boundary is expected to handle.
 */

/** The version this build speaks. */
export const CURRENT_SCHEMA_VERSION = "1.0";

/** Older versions still served, newest last. */
export const DEPRECATED_SCHEMA_VERSIONS = ["0.9"] as const;

export interface VersionFixture {
  /** Stable id, used as the test name and in the docs table. */
  readonly id: string;
  /** What a consumer would send as `schemaVersion`. */
  readonly requested: string | null;
  /** Why this shape matters, in one line. */
  readonly intent: string;
  /** The code the boundary must answer with, or `null` when it is served. */
  readonly expectedCode: "schema_missing" | "schema_deprecated" | "schema_future" | "schema_unsupported" | null;
  /** What the consumer should do. `null` when the version is served as-is. */
  readonly expectedGuidance: "retry" | "upgrade" | "safe_fallback" | null;
}

export const VERSION_FIXTURES: readonly VersionFixture[] = [
  {
    id: "missing",
    requested: null,
    intent: "no version at all — a caller bug, refused rather than assumed current",
    expectedCode: "schema_missing",
    expectedGuidance: "upgrade"
  },
  {
    id: "empty",
    requested: "",
    intent: "an empty string is no version, not a version that happens to be blank",
    expectedCode: "schema_missing",
    expectedGuidance: "upgrade"
  },
  {
    id: "unsupported",
    requested: "latest",
    intent: "text that is not a version must not be coerced into one",
    expectedCode: "schema_unsupported",
    expectedGuidance: "upgrade"
  },
  {
    id: "unsupported-older",
    requested: "0.4",
    intent: "an older version that is no longer served cannot be reconstructed",
    expectedCode: "schema_unsupported",
    expectedGuidance: "upgrade"
  },
  {
    id: "deprecated",
    requested: "0.9",
    intent: "still served: the payload is valid and the consumer is told to plan an upgrade",
    expectedCode: null,
    expectedGuidance: null
  },
  {
    id: "current",
    requested: "1.0",
    intent: "the version this build speaks, served without comment",
    expectedCode: null,
    expectedGuidance: null
  },
  {
    id: "future",
    requested: "2.0",
    intent: "newer than this build: fall back rather than interpret a payload that may mean something else",
    expectedCode: "schema_future",
    expectedGuidance: "safe_fallback"
  },
  {
    id: "future-minor",
    requested: "1.5",
    intent: "a newer minor of the current major is still a future version",
    expectedCode: "schema_future",
    expectedGuidance: "safe_fallback"
  }
] as const;
