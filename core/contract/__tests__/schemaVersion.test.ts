import { describe, expect, it } from "vitest";
import {
  negotiateSchemaVersion,
  negotiateSchemaVersionOrError,
  type SchemaCompatibility,
  type SchemaVersionErrorCode
} from "@/core/contract/contract";
import {
  CURRENT_SCHEMA_VERSION,
  DEPRECATED_SCHEMA_VERSIONS,
  VERSION_FIXTURES
} from "@/core/contract/fixtures/schemaVersions";

/**
 * Version negotiation at the API contract boundary (issue #149).
 *
 * Version drift needs a deterministic answer *before* a consumer interprets an
 * incompatible payload, and the answer has to distinguish four situations,
 * because they call for different responses: a missing version is a caller bug,
 * a deprecated one still works, a future one must be ignored rather than
 * half-read, and an unsupported one can only be upgraded. Collapsing them into
 * one "unsupported" answer is what leaves a consumer guessing whether retrying,
 * upgrading or falling back is the right move.
 *
 * The cases live in `core/contract/fixtures/schemaVersions.ts` so the exporter,
 * the docs and this suite negotiate the same four shapes.
 */
const negotiate = (requested: string | null): SchemaCompatibility =>
  negotiateSchemaVersion({
    requested,
    current: CURRENT_SCHEMA_VERSION,
    deprecated: DEPRECATED_SCHEMA_VERSIONS
  });

describe("schema version negotiation", () => {
  it("has a fixture for every shape the boundary must answer", () => {
    const ids = VERSION_FIXTURES.map((fixture) => fixture.id);

    for (const shape of ["missing", "unsupported", "deprecated", "future"]) {
      expect(ids, `no fixture covers the "${shape}" shape`).toContain(shape);
    }
  });

  it.each(VERSION_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "answers %s deterministically",
    (_id, fixture) => {
      const outcome = negotiate(fixture.requested);

      expect(outcome.code ?? null).toBe(fixture.expectedCode);
      expect(outcome.guidance ?? null).toBe(fixture.expectedGuidance);
      // The answer is a pure function of the request: the same input twice gives
      // the same verdict and the same wording, which is what makes it testable
      // by a consumer.
      expect(negotiate(fixture.requested)).toEqual(outcome);
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  );

  it("serves the current version without comment", () => {
    const outcome = negotiate(CURRENT_SCHEMA_VERSION);

    expect(outcome.status).toBe("ok");
    expect(outcome.code).toBeUndefined();
    expect(outcome.guidance).toBeUndefined();
    expect(outcome.requested).toBe(CURRENT_SCHEMA_VERSION);
    expect(outcome.supported).toContain(CURRENT_SCHEMA_VERSION);
  });

  it("serves a deprecated version but marks it, so nothing breaks and the upgrade is still visible", () => {
    const outcome = negotiate("0.9");

    // Served, not refused: refusing a version this build supports would break a
    // consumer for no reason.
    expect(outcome.status).toBe("deprecated");
    expect(outcome.code).toBeUndefined();
    expect(outcome.supported).toContain("0.9");
    // …and marked, because a silent deprecation is how a consumer finds out on
    // the day it stops being served.
    expect(outcome.reason).toContain(CURRENT_SCHEMA_VERSION);
    expect(outcome.reason).toMatch(/deprecat/i);
  });

  it("tells a future-version consumer to fall back rather than interpret the payload", () => {
    const outcome = negotiate("2.0");

    expect(outcome.code).toBe("schema_future");
    expect(outcome.guidance).toBe("safe_fallback");
    // The reason has to say why falling back is the safe move, because that is
    // the part a consumer cannot infer from the code alone.
    expect(outcome.reason).toMatch(/fall back|fallback/i);
  });

  it("reports a missing version as a caller bug, not a version problem", () => {
    for (const requested of [null, "", "   "]) {
      const outcome = negotiate(requested);
      expect(outcome.code).toBe("schema_missing");
      expect(outcome.requested).toBeNull();
      // Never "safe_fallback": falling back would mean guessing a version, which
      // is the failure this case exists to prevent.
      expect(outcome.guidance).not.toBe("safe_fallback");
    }
  });

  it("refuses a non-version string rather than coercing it", () => {
    for (const requested of ["latest", "v1", "1", "1.0.0-beta", "one"]) {
      const outcome = negotiate(requested);
      expect(outcome.code, `"${requested}" must not be coerced`).toBe("schema_unsupported");
    }
  });

  it("lists every version it serves, so the refusal is actionable", () => {
    const outcome = negotiate("0.4");

    expect(outcome.code).toBe("schema_unsupported");
    expect(outcome.supported).toEqual([CURRENT_SCHEMA_VERSION, "0.9"]);
    expect(outcome.reason).toContain(CURRENT_SCHEMA_VERSION);
    expect(outcome.reason).toContain("0.9");
  });

  it("wraps a refusal in the shared Result for callers that switch on the code", () => {
    const refused = negotiateSchemaVersionOrError({
      requested: "2.0",
      current: CURRENT_SCHEMA_VERSION
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe<SchemaVersionErrorCode>("schema_future");
    expect(refused.detail?.guidance).toBe("safe_fallback");

    const served = negotiateSchemaVersionOrError({
      requested: CURRENT_SCHEMA_VERSION,
      current: CURRENT_SCHEMA_VERSION
    });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.value.requested).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("treats a deprecated version as served through the Result wrapper too", () => {
    const outcome = negotiateSchemaVersionOrError({
      requested: "0.9",
      current: CURRENT_SCHEMA_VERSION,
      deprecated: DEPRECATED_SCHEMA_VERSIONS
    });

    // No code: the Result is the contract a consumer switches on, and a
    // deprecation is not a refusal.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe("deprecated");
  });

  it("does not list the current version twice when it is also declared deprecated", () => {
    const outcome = negotiateSchemaVersion({
      requested: "3.0",
      current: CURRENT_SCHEMA_VERSION,
      deprecated: [CURRENT_SCHEMA_VERSION, "0.9"]
    });

    expect(outcome.supported).toEqual([CURRENT_SCHEMA_VERSION, "0.9"]);
  });

  it("ignores surrounding whitespace in a version", () => {
    expect(negotiate(` ${CURRENT_SCHEMA_VERSION} `).code).toBeUndefined();
  });
});
