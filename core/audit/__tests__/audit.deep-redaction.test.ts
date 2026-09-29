/**
 * Deep redaction and cyclic-payload tests for audit.ts — issue #147.
 *
 * Acceptance criteria:
 *  - Nested arrays and objects have secrets stripped at every depth.
 *  - Circular references never cause infinite recursion or unhandled throws.
 *  - Large strings are handled without crashing.
 *  - Key-case variations (SECRET, Secret, sEcReT) are all redacted.
 *  - A redacted audit event is always serializable with JSON.stringify.
 *  - `auditContext` enforces the AUDIT_MAX_CONTEXT_KEYS cap.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  auditContext,
  createIsolatedAuditTrail,
  AUDIT_MAX_CONTEXT_KEYS,
  type AuditInput,
} from "@/core/audit/audit";
import { redact, MAX_REDACT_DEPTH } from "@/core/telemetry/telemetry";

// ── Helpers ───────────────────────────────────────────────────────────────────

const AT = "2026-09-26T00:00:00.000Z";

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    action: "record.state_changed",
    actor: { kind: "maintainer", id: "ada" },
    scope: "maintainer",
    target: { kind: "worker_job", id: "job-1" },
    at: AT,
    ...overrides,
  };
}

// ── auditContext: nested arrays ───────────────────────────────────────────────

describe("auditContext — nested arrays and objects", () => {
  it("accepts primitive values at the top level", () => {
    const ctx = auditContext({ state: "retrying", count: 3, flag: true });
    expect(ctx).toEqual({ state: "retrying", count: 3, flag: true });
  });

  it("drops non-primitive values (objects, arrays) rather than serialising them", () => {
    const ctx = auditContext({
      nested: { inner: "should be dropped" },
      arr: [1, 2, 3],
      state: "ok",
    });
    // nested and arr must not appear; only the primitive 'state' survives
    expect(ctx).not.toHaveProperty("nested");
    expect(ctx).not.toHaveProperty("arr");
    expect(ctx).toEqual({ state: "ok" });
  });

  it("redacts values whose key matches the sensitive-key pattern (secret, token, key)", () => {
    const ctx = auditContext({
      secret: "SABC123STELLARSEED",
      apiToken: "bearer-xyz",
      password: "hunter2",
      state: "ok",
    });
    expect(ctx?.secret).toBe("[REDACTED]");
    expect(ctx?.apiToken).toBe("[REDACTED]");
    expect(ctx?.password).toBe("[REDACTED]");
    expect(ctx?.state).toBe("ok");
  });

  it("redacts sensitive keys regardless of case (SECRET, Secret, sEcReT)", () => {
    const ctx = auditContext({
      SECRET: "top-secret",
      Secret: "also-secret",
      sEcReT: "still-secret",
      normalField: "visible",
    });
    expect(ctx?.SECRET).toBe("[REDACTED]");
    expect(ctx?.Secret).toBe("[REDACTED]");
    expect(ctx?.sEcReT).toBe("[REDACTED]");
    expect(ctx?.normalField).toBe("visible");
  });

  it("truncates string values to AUDIT_MAX_VALUE_LENGTH (160 chars)", () => {
    const longValue = "x".repeat(300);
    const ctx = auditContext({ payload: longValue });
    expect(ctx?.payload).toHaveLength(160);
  });

  it("scrubs embedded Stellar secret seeds inside string values", () => {
    // A valid Stellar secret key is S + 55 uppercase base32 chars (A-Z, 2-7)
    const seed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";
    const ctx = auditContext({ info: `context: ${seed} more text` });
    expect(JSON.stringify(ctx)).not.toContain(seed);
    expect(ctx?.info).toContain("[REDACTED]");
  });

  it("caps keys at AUDIT_MAX_CONTEXT_KEYS and drops the rest", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < AUDIT_MAX_CONTEXT_KEYS + 5; i++) {
      input[`field_${i}`] = `value_${i}`;
    }
    const ctx = auditContext(input);
    expect(Object.keys(ctx!).length).toBe(AUDIT_MAX_CONTEXT_KEYS);
  });

  it("returns undefined for an empty input object", () => {
    expect(auditContext({})).toBeUndefined();
  });

  it("returns undefined for undefined/null input", () => {
    expect(auditContext(undefined)).toBeUndefined();
  });
});

// ── auditContext: result is always JSON-serializable ──────────────────────────

describe("auditContext — JSON serializability", () => {
  it("always produces a JSON-serializable context", () => {
    const ctx = auditContext({
      state: "retrying",
      count: 5,
      flag: true,
      secret: "should-be-redacted",
      nested: { wont: "appear" },
    });
    expect(() => JSON.stringify(ctx)).not.toThrow();
  });
});

// ── Audit trail: before/after context is redacted before persistence ──────────

describe("audit trail — redaction on record", () => {
  it("stores a redacted context — no raw secrets in the persisted event", () => {
    const trail = createIsolatedAuditTrail();
    const result = trail.record(
      baseInput({
        before: {
          state: "active",
          secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3",
        },
        after: { state: "dead_lettered" },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.value);
    // The raw secret seed must not appear anywhere in the stored event
    expect(serialized).not.toContain("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // The redacted placeholder must appear
    expect(result.value.before?.secret).toBe("[REDACTED]");
  });

  it("stores a redacted context for case-variant sensitive keys", () => {
    const trail = createIsolatedAuditTrail();
    const result = trail.record(
      baseInput({
        before: { TOKEN: "raw-bearer-abc", State: "retrying" },
        after: { state: "dead_lettered" },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before?.TOKEN).toBe("[REDACTED]");
  });

  it("produces a fully JSON-serializable event", () => {
    const trail = createIsolatedAuditTrail();
    const result = trail.record(
      baseInput({
        before: { state: "retrying", amount: 100 },
        after: { state: "dead_lettered", event: "dead_letter" },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => JSON.stringify(result.value)).not.toThrow();
  });
});

// ── redact (telemetry) — deep nested structures ───────────────────────────────

describe("redact — deep nested structures", () => {
  it("redacts secret keys at every nesting level", () => {
    const payload = {
      user: {
        profile: {
          secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3",
          name: "Alice",
        },
      },
      token: "raw-token",
    };
    const result = redact(payload) as typeof payload;
    expect((result.user as any).profile.secret).toBe("[REDACTED]");
    expect((result.user as any).profile.name).toBe("Alice");
    expect((result as any).token).toBe("[REDACTED]");
  });

  it("redacts secrets inside nested arrays", () => {
    const payload = {
      items: [
        { id: "a1", secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3" },
        { id: "a2", name: "visible" },
      ],
    };
    const result = redact(payload) as any;
    expect(result.items[0].secret).toBe("[REDACTED]");
    expect(result.items[1].name).toBe("visible");
  });

  it("redacts embedded Stellar secret seeds in string values", () => {
    const seed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";
    const result = redact({ info: `seed: ${seed}` }) as any;
    expect(result.info).not.toContain(seed);
    expect(result.info).toContain("[REDACTED]");
  });

  it("truncates at MAX_REDACT_DEPTH and returns [TRUNCATED_DEPTH]", () => {
    // Build an object nested deeper than MAX_REDACT_DEPTH
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < MAX_REDACT_DEPTH + 2; i++) {
      deep = { level: deep };
    }
    const result = redact(deep);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("TRUNCATED_DEPTH");
  });
});

// ── redact — circular reference safety ───────────────────────────────────────

describe("redact — circular reference payloads", () => {
  it("does not throw on a direct self-referencing object", () => {
    const obj: Record<string, unknown> = { id: "root" };
    obj.self = obj; // circular
    expect(() => redact(obj)).not.toThrow();
    const result = redact(obj) as any;
    expect(result.self).toBe("[CIRCULAR]");
  });

  it("does not throw on a multi-hop cycle (A → B → A)", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", ref: a };
    a.ref = b; // cycle: a.ref = b, b.ref = a
    expect(() => redact(a)).not.toThrow();
    const result = redact(a) as any;
    expect(result.ref.ref).toBe("[CIRCULAR]");
  });

  it("does not throw on a deeply cyclic array", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr); // arr[2] = arr
    expect(() => redact(arr)).not.toThrow();
    const result = redact(arr) as unknown[];
    expect(result[2]).toBe("[CIRCULAR]");
  });

  it("result of circular-ref redaction is always JSON-serializable", () => {
    const obj: Record<string, unknown> = { id: "node" };
    obj.self = obj;
    const result = redact(obj);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("does not throw when a cyclic object also contains sensitive keys", () => {
    const obj: Record<string, unknown> = { id: "x", secret: "raw-secret" };
    obj.loop = obj;    expect(() => redact(obj)).not.toThrow();
    const result = redact(obj) as any;
    expect(result.secret).toBe("[REDACTED]");
    expect(result.loop).toBe("[CIRCULAR]");
  });
});

// ── redact — large strings ────────────────────────────────────────────────────

describe("redact — large string handling", () => {
  it("does not throw on a string larger than MAX_SCANNABLE_STRING_LENGTH", () => {
    const huge = "a".repeat(600_000);
    expect(() => redact(huge)).not.toThrow();
  });

  it("truncates a string larger than MAX_SCANNABLE_STRING_LENGTH", () => {
    const huge = "a".repeat(600_000);
    const result = redact(huge) as string;
    expect(result).toContain("[TRUNCATED]");
    expect(result.length).toBeLessThan(huge.length);
  });

  it("still redacts an embedded secret in a large string before truncation point", () => {
    const seed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";
    // Place the seed near the start so it's within the scannable window
    const huge = seed + "b".repeat(600_000);
    const result = redact(huge) as string;
    expect(result).not.toContain(seed);
    expect(result).toContain("[REDACTED]");
  });
});

// ── Audit trail: event is serializable after cyclic-safe context ──────────────

describe("audit trail — serializable after redaction", () => {
  it("all events returned by .all() are JSON-serializable", () => {
    const trail = createIsolatedAuditTrail();

    for (let i = 0; i < 3; i++) {
    trail.record(
        baseInput({
          before: { state: "retrying", secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3" },
          after: { state: "dead_lettered" },
          at: AT,
        })
      );
    }

    const events = trail.all();
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it("export as json produces valid, parseable output", () => {
    const trail = createIsolatedAuditTrail();
    trail.record(baseInput({ before: { state: "ok" }, at: AT }));

    const exported = trail.export({ kind: "maintainer", id: "ada" }, { format: "json" });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(() => JSON.parse(exported.value)).not.toThrow();
    const parsed = JSON.parse(exported.value);
    expect(parsed).toHaveProperty("events");
  });
});
