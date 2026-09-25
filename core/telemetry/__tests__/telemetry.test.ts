import { afterEach, describe, expect, it } from "vitest";
import { err, ok } from "@/core/result/result";
import {
  TELEMETRY_FIELDS,
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