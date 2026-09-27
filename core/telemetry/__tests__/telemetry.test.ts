import { afterEach, describe, expect, it } from "vitest";
import { err, ok } from "@/core/result/result";
import {
  TELEMETRY_FIELDS,
  createCaptureSink,
  measure,
  measureSync,
  newCorrelationId,
  redact,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryEvent,
  type TelemetrySink
} from "@/core/telemetry/telemetry";

function memSink(): { sink: TelemetrySink; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  const sink: TelemetrySink = { emit: (event) => events.push(event) };
  return { sink, events };
}

afterEach(() => {
  resetTelemetrySink();
});

describe("telemetry fields", () => {
  it("emits success with op, actorType, result, latencyMs and correlationId", async () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);

    const correlationId = newCorrelationId();

    await measure("export.generate", { actorType: "user", correlationId }, () =>
      ok({ rows: 3 })
    );

    expect(events).toHaveLength(1);
    const record = events[0];
    for (const field of TELEMETRY_FIELDS) {
      expect(record).toHaveProperty(field);
    }
    expect(record.op).toBe("export.generate");
    expect(record.actorType).toBe("user");
    expect(record.result).toBe("success");
    expect(record.correlationId).toBe(correlationId);
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("emits failure with the Result error code when the work returns err()", async () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);

    await measure("export.generate", { actorType: "user" }, () =>
      err("schema_unsupported")
    );

    expect(events[0].result).toBe("failure");
    expect(events[0].errorCode).toBe("schema_unsupported");
  });

  it("emits failure when the work throws", async () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);

    await expect(
      measure("contract.validate", { actorType: "system" }, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(events[0].result).toBe("failure");
    expect(events[0].errorCode).toBe("Error");
  });

  it("measureSync emits and returns the value", () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);

    const value = measureSync("contract.snapshot", { actorType: "system" }, () => 42);

    expect(value).toBe(42);
    expect(events[0].op).toBe("contract.snapshot");
    expect(events[0].result).toBe("success");
  });
});

describe("redaction", () => {
  it("never lets a Stellar secret seed reach a sink", async () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);
    const secret = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";

    await measure("horizon.request", { actorType: "client", payload: { secret } }, () =>
      ok(true)
    );

    expect(events[0].payload?.secret).toBe("[REDACTED]");
  });

  it("redacts named sensitive keys and keeps the record shape", () => {
    const out = redact({ passphrase: "x", ok: true, nested: ["a", "SBXKEY212121"] });
    expect(out).toEqual({ passphrase: "[REDACTED]", ok: true, nested: ["a", "[REDACTED]"] });
  });

  it("handles circular objects and arrays without crashing and remains serializable", () => {
    const cyclicObj: Record<string, unknown> = { name: "operation", details: { step: 1 } };
    cyclicObj.self = cyclicObj;
    (cyclicObj.details as Record<string, unknown>).parent = cyclicObj;

    const outObj = redact(cyclicObj) as Record<string, unknown>;
    expect(outObj.self).toBe("[CIRCULAR]");
    expect((outObj.details as Record<string, unknown>).parent).toBe("[CIRCULAR]");
    expect(() => JSON.stringify(outObj)).not.toThrow();

    const cyclicArr: unknown[] = ["first"];
    cyclicArr.push(cyclicArr);
    const outArr = redact(cyclicArr) as unknown[];
    expect(outArr[1]).toBe("[CIRCULAR]");
    expect(() => JSON.stringify(outArr)).not.toThrow();
  });

  it("handles deeply nested structures with bounded traversal depth", () => {
    let deep: Record<string, unknown> = { leaf: "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW" };
    for (let i = 0; i < 20; i++) {
      deep = { next: deep };
    }
    const out = redact(deep);
    expect(() => JSON.stringify(out)).not.toThrow();
    // At deep levels beyond MAX_REDACT_DEPTH (16), truncated marker is placed
    const jsonStr = JSON.stringify(out);
    expect(jsonStr).toContain("[TRUNCATED_DEPTH]");
  });

  it("redacts key-case variations and auth variants", () => {
    const out = redact({
      APIKEY: "val1",
      secret_seed: "val2",
      AUTH_TOKEN: "val3",
      passWord: "val4",
      Authorization: "Bearer xyz",
      cookie: "session=123",
      normalKey: "allowed"
    }) as Record<string, unknown>;

    expect(out.APIKEY).toBe("[REDACTED]");
    expect(out.secret_seed).toBe("[REDACTED]");
    expect(out.AUTH_TOKEN).toBe("[REDACTED]");
    expect(out.passWord).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.normalKey).toBe("allowed");
  });

  it("scrubs embedded secrets and bearer tokens in preformatted strings and large strings", () => {
    const seed = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";
    const text = `Error connecting to Horizon with seed ${seed} and header Bearer eyJhbGciOiJIUzI1NiJ9`;
    const out = redact(text);
    expect(out).toBe("Error connecting to Horizon with seed [REDACTED] and header [REDACTED]");

    // Large string test
    const padding = "A".repeat(50_000);
    const largeText = `${padding} ${seed} ${padding}`;
    const largeOut = redact(largeText) as string;
    expect(largeOut.includes(seed)).toBe(false);
    expect(largeOut.includes("[REDACTED]")).toBe(true);
  });
});

describe("capture sink", () => {
  it("records, finds, filters, and clears events correctly", () => {
    const sink = createCaptureSink();
    expect(sink.events).toHaveLength(0);
    expect(sink.latest()).toBeUndefined();

    sink.emit({
      op: "horizon.request",
      actorType: "client",
      result: "success",
      latencyMs: 12,
      correlationId: "c1",
      timestamp: "2026-09-27T00:00:00.000Z"
    });

    sink.emit({
      op: "export.generate",
      actorType: "user",
      result: "failure",
      errorCode: "timeout",
      latencyMs: 150,
      correlationId: "c2",
      timestamp: "2026-09-27T00:00:01.000Z"
    });

    expect(sink.events).toHaveLength(2);
    expect(sink.latest()?.op).toBe("export.generate");
    expect(sink.find((e) => e.op === "horizon.request")?.correlationId).toBe("c1");
    expect(sink.filter((e) => e.result === "failure")).toHaveLength(1);

    sink.clear();
    expect(sink.events).toHaveLength(0);
    expect(sink.latest()).toBeUndefined();
  });
});

describe("correlation ids", () => {
  it("generates distinct ids and shares one across a fan-out", async () => {
    const { sink, events } = memSink();
    setTelemetrySink(sink);
    const correlationId = newCorrelationId();

    await Promise.all([
      measure("worker.run", { actorType: "worker", correlationId }, () => ok(true)),
      measure("worker.retry", { actorType: "worker", correlationId }, () => ok(true))
    ]);

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.correlationId === correlationId)).toBe(true);
    expect(new Set([correlationId, newCorrelationId()]).size).toBe(2);
  });
});