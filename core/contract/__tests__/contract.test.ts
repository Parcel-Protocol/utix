import { describe, expect, it } from "vitest";
import {
  TELEMETRY_FIELDS,
  measure,
  newCorrelationId,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryEvent
} from "@/core/telemetry/telemetry";
import { classifyHorizonError } from "@/core/horizon/errors";
import { createWorkerFramework, type JobPayload } from "@/core/workers/queue";
import { ok } from "@/core/result/result";
import {
  EXPORT_CURRENT_SCHEMA_VERSION,
  exportRecords,
  type ExportRecordSource
} from "@/core/export/exporter";
import type { FeatureManifest } from "@/core/registry/types";
import { manifest as paymentQrManifest } from "@/features/payment-qr/manifest";
import {
  assertContract,
  contractOperation,
  validateContract
} from "@/core/contract/contract";

const V = "1.0";

// The five contracts documented in docs/API_CONTRACT.md, kept in lockstep with
// the real modules below. When a module changes a shape used by consumers,
// this file must change too — which is the point of a drift test.

const telemetryContract = contractOperation("telemetry.event", {
  version: V,
  fields: {
    op: { type: "string", required: true },
    actorType: { type: "string", required: true },
    result: { type: "string", required: true },
    latencyMs: { type: "number", required: true },
    correlationId: { type: "string", required: true }
  }
});

const horizonErrorContract = contractOperation("horizon.error", {
  version: V,
  fields: {
    code: { type: "string", required: true },
    detail: { type: "object", required: true },
    "detail.status": { type: "number", required: false }
  }
});

const workerJobContract = contractOperation("worker.job", {
  version: V,
  fields: {
    id: { type: "string", required: true },
    operation: { type: "string", required: true },
    attempts: { type: "number", required: true },
    status: { type: "string", required: true },
    enqueuedAt: { type: "string", required: true },
    correlationId: { type: "string", required: true }
  }
});

const exportEnvelopeContract = contractOperation("export.envelope", {
  version: V,
  fields: {
    schemaVersion: { type: "string", required: true },
    generatedAt: { type: "string", required: true },
    expiresAt: { type: "string", required: true },
    generator: { type: "string", required: true },
    correlationId: { type: "string", required: true },
    recordCount: { type: "number", required: true },
    totalRecords: { type: "number", required: true },
    records: { type: "array", required: true }
  }
});

const featureManifestContract = contractOperation("feature.manifest", {
  version: V,
  fields: {
    slug: { type: "string", required: true },
    title: { type: "string", required: true },
    description: { type: "string", required: true },
    category: { type: "string", required: true },
    status: { type: "string", required: true }
  }
});

async function realTelemetryEvent(): Promise<TelemetryEvent> {
  let seen: TelemetryEvent | undefined;
  setTelemetrySink({ emit: (event) => (seen = event) });

  const correlationId = newCorrelationId();
  await measure("horizon.request", { actorType: "client", correlationId }, () => ok(true));
  resetTelemetrySink();

  if (!seen) throw new Error("no telemetry emitted");
  return seen;
}

describe("contract drift tests", () => {
  it("locks the telemetry record shape to what the module emits", async () => {
    const record = await realTelemetryEvent();
    expect(TELEMETRY_FIELDS.every((field) => field in record)).toBe(true);
    expect(assertContract(telemetryContract, () => record).ok).toBe(true);
  });

  it("locks the horizon error classification shape", () => {
    const classified = classifyHorizonError({ response: { status: 429 } });
    expect(assertContract(horizonErrorContract, () => classified).ok).toBe(true);
  });

  it("locks the worker job payload shape", () => {
    const framework = createWorkerFramework();
    const job: JobPayload = framework.enqueue({ operation: "demo.run" });
    expect(assertContract(workerJobContract, () => job).ok).toBe(true);
  });

  it("locks the export envelope shape", () => {
    const source: ExportRecordSource = {
      recordType: "operation_log",
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "own",
      collect: () => [{ op: "wallet.detect", result: "success" }]
    };
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(assertContract(exportEnvelopeContract, () => result.value).ok).toBe(true);
  });

  it("locks the feature manifest shape", () => {
    const manifest: FeatureManifest = paymentQrManifest;
    expect(assertContract(featureManifestContract, () => manifest).ok).toBe(true);
  });

  it("detects a drifted response that drops a required field", () => {
    const drifted = { detail: {}, status: 200 }; // `code` is required
    expect(validateContract(drifted, horizonErrorContract.schema).ok).toBe(false);
    expect(assertContract(horizonErrorContract, () => drifted).ok).toBe(false);
  });
});