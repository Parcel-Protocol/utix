import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHorizonRequest } from "@/core/horizon/request";
import { exportRecords, type ExportRequest } from "@/core/export/exporter";
import {
  TELEMETRY_FIELDS,
  createCaptureSink,
  emitTelemetry,
  measure,
  measureSync,
  newCorrelationId,
  redact,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryCaptureSink,
  type TelemetryEvent
} from "@/core/telemetry/telemetry";
import { runAgainstNetworkProfiles } from "@/core/testing/runAgainstProfiles";

describe("feature boundary telemetry redaction", () => {
  let sink: TelemetryCaptureSink;

  beforeEach(() => {
    sink = createCaptureSink();
    setTelemetrySink(sink);
  });

  afterEach(() => {
    resetTelemetrySink();
  });

  describe("correlation metadata and allowed fields", () => {
    it("preserves required correlation fields and metadata on feature failure", () => {
      const correlationId = newCorrelationId();

      emitTelemetry({
        op: "horizon.request",
        actorType: "client",
        result: "failure",
        latencyMs: 42,
        correlationId,
        errorCode: "timeout",
        payload: {
          endpoint: "https://horizon-testnet.stellar.org/accounts",
          attempt: 2
        }
      });

      expect(sink.events).toHaveLength(1);
      const event = sink.latest()!;

      // Allowed correlation metadata
      expect(event.op).toBe("horizon.request");
      expect(event.actorType).toBe("client");
      expect(event.result).toBe("failure");
      expect(event.latencyMs).toBe(42);
      expect(event.correlationId).toBe(correlationId);
      expect(event.errorCode).toBe("timeout");
      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).getTime()).not.toBeNaN();
      expect(event.payload?.endpoint).toBe("https://horizon-testnet.stellar.org/accounts");
      expect(event.payload?.attempt).toBe(2);

      // Verify all required contract keys are present
      for (const required of TELEMETRY_FIELDS) {
        expect(event).toHaveProperty(required);
      }
    });
  });

  describe("preformatted sensitive strings and raw HTTP bodies at caller boundary", () => {
    const secretSeed = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";
    const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const rawHttpBody = JSON.stringify({
      type: "bad_request",
      title: "Transaction Failed",
      status: 400,
      detail: `Seed ${secretSeed} is invalid for this envelope`,
      extras: { envelope_xdr: "AAAAAGX..." }
    });

    it("scrubs embedded secrets when callers preformat error strings", () => {
      const preformattedError = `Horizon failed for seed ${secretSeed} using ${bearerToken}`;

      emitTelemetry({
        op: "horizon.request",
        actorType: "client",
        result: "failure",
        errorCode: `err_for_${secretSeed}`,
        payload: {
          message: preformattedError,
          rawBody: rawHttpBody,
          responseBody: rawHttpBody,
          body: rawHttpBody
        }
      });

      const event = sink.latest()!;
      expect(event.result).toBe("failure");

      // errorCode must have scrubbed secret
      expect(event.errorCode).not.toContain(secretSeed);
      expect(event.errorCode).toContain("[REDACTED]");

      // payload message must have scrubbed seed and bearer token
      const payload = event.payload as Record<string, unknown>;
      expect(payload.message).not.toContain(secretSeed);
      expect(payload.message).not.toContain(bearerToken);
      expect(payload.message).toBe("Horizon failed for seed [REDACTED] using [REDACTED]");

      // raw HTTP body keys must be redacted
      expect(payload.rawBody).toBe("[REDACTED]");
      expect(payload.responseBody).toBe("[REDACTED]");
      expect(payload.body).toBe("[REDACTED]");

      // Verify complete serialization is clean of secret material
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(secretSeed);
      expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiI");
      expect(serialized).not.toContain("AAAAAGX");
    });

    it("redacts raw HTTP body and disallowed address keys in feature payloads", () => {
      const publicAddress = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

      emitTelemetry({
        op: "export.generate",
        actorType: "user",
        result: "failure",
        errorCode: "export_denied",
        payload: {
          allowedAccountId: publicAddress,
          disallowedAddress: publicAddress,
          forbiddenAddress: publicAddress,
          raw_body: "RAW_STREAM_DATA",
          httpBody: "HTTP_PAYLOAD"
        }
      });

      const event = sink.latest()!;
      const payload = event.payload as Record<string, unknown>;

      // Allowed public account is preserved in non-sensitive context
      expect(payload.allowedAccountId).toBe(publicAddress);

      // Disallowed address keys are redacted
      expect(payload.disallowedAddress).toBe("[REDACTED]");
      expect(payload.forbiddenAddress).toBe("[REDACTED]");

      // Raw HTTP body fields are redacted
      expect(payload.raw_body).toBe("[REDACTED]");
      expect(payload.httpBody).toBe("[REDACTED]");
    });

    it("supports address redaction when explicitly requested", () => {
      const publicAddress = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const unredacted = {
        destination: publicAddress,
        info: `Payment sent to ${publicAddress}`
      };

      const out = redact(unredacted, 0, new WeakSet(), { redactAddresses: true }) as Record<string, string>;
      expect(out.destination).toBe("[REDACTED]");
      expect(out.info).toBe("Payment sent to [REDACTED]");
      expect(JSON.stringify(out)).not.toContain(publicAddress);
    });
  });

  describe("actual feature request and error execution paths", () => {
    it("captures correlation metadata on Horizon timeout without leaking raw errors", async () => {
      const correlationId = newCorrelationId();
      const hangingRequest = new Promise((resolve) => setTimeout(resolve, 500));

      await expect(
        runHorizonRequest(hangingRequest, {
          timeoutMs: 10,
          correlationId
        })
      ).rejects.toThrow("Horizon request timed out");

      expect(sink.events).toHaveLength(1);
      const event = sink.latest()!;
      expect(event.op).toBe("horizon.request");
      expect(event.actorType).toBe("client");
      expect(event.result).toBe("failure");
      expect(event.errorCode).toBe("timeout");
      expect(event.correlationId).toBe(correlationId);
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("captures correlation metadata on Horizon cancellation", async () => {
      const controller = new AbortController();
      const correlationId = newCorrelationId();
      const hangingRequest = new Promise((resolve) => setTimeout(resolve, 500));

      const promise = runHorizonRequest(hangingRequest, {
        signal: controller.signal,
        correlationId
      });

      controller.abort();

      await expect(promise).rejects.toThrow("Horizon request cancelled");

      expect(sink.events).toHaveLength(1);
      const event = sink.latest()!;
      expect(event.op).toBe("horizon.request");
      expect(event.result).toBe("failure");
      expect(event.errorCode).toBe("cancelled");
      expect(event.correlationId).toBe(correlationId);
    });

    it("captures correlation metadata in export workflow without leaking maintainer tokens", () => {
      const secretToken = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";
      const request: ExportRequest = {
        actor: { kind: "user" },
        scope: "maintainer", // User requesting maintainer scope fails authorization
        correlationId: newCorrelationId()
      };

      const result = exportRecords(request, []);
      expect(result.ok).toBe(false);

      const event = sink.latest()!;
      expect(event.op).toBe("export.generate");
      expect(event.actorType).toBe("user");
      expect(event.result).toBe("failure");
      expect(event.errorCode).toBe("export_denied");
      expect(event.correlationId).toBe(request.correlationId);

      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(secretToken);
    });
  });
});

describe("runAgainstNetworkProfiles telemetry context integration", () => {
  runAgainstNetworkProfiles(
    { featureNetworks: ["testnet", "mainnet"] },
    (ctx) => {
      it(`[${ctx.profile.id}] provides capture sink in profile context and records Horizon requests`, async () => {
        expect(ctx.telemetry).toBeDefined();
        ctx.telemetry!.clear();

        // Perform a simulated Horizon request using the profile's horizonUrl
        const correlationId = newCorrelationId();
        const request = fetch(`${ctx.profile.horizonUrl}/accounts/${ctx.fixtures.accountId}`);

        const result = await runHorizonRequest(request, { correlationId });
        expect(result).toBeDefined();

        const events = ctx.telemetry!.events;
        expect(events.length).toBeGreaterThanOrEqual(1);

        const horizonEvent = ctx.telemetry!.find((e) => e.op === "horizon.request");
        expect(horizonEvent).toBeDefined();
        expect(horizonEvent!.actorType).toBe("client");
        expect(horizonEvent!.correlationId).toBe(correlationId);
        expect(horizonEvent!.result).toBe("success");

        // Verify no raw HTTP body or secrets in the telemetry record
        const serialized = JSON.stringify(horizonEvent);
        expect(serialized).not.toContain(ctx.fixtures.accountId); // The telemetry event doesn't log the raw account
        expect(horizonEvent!.payload).toBeUndefined();
      });
    }
  );
});
