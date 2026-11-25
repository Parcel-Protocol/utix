import { afterEach, describe, expect, it } from "vitest";
import type { HealthStatus } from "@/core/health/types";
import { err, ok } from "@/core/result/result";
import { createCaptureSink, resetTelemetrySink, setTelemetrySink } from "@/core/telemetry/telemetry";
import type { JourneyId, JourneyReport } from "../journeys";
import { createWorkflowMonitor, WORKFLOW_STATE_VERSION, type WorkflowMonitorOptions } from "../workflow-monitor";

const SERVICE = { role: "service" } as const;
const RUN = { network: "testnet" } as const;
const START = Date.parse("2026-11-21T00:00:00.000Z");

function report(journey: JourneyId, status: HealthStatus): JourneyReport {
  return {
    journey,
    network: "testnet",
    status,
    correlationId: `${journey}-run`,
    startedAt: new Date(START).toISOString(),
    durationMs: 12,
    steps:
      status === "unhealthy"
        ? [
            { step: "horizon.root", ok: false, attempts: 3, latencyMs: 5, errorCode: "server_error" },
            { step: "fee_stats.load", ok: false, attempts: 0, latencyMs: 0, errorCode: "skipped", skipped: true }
          ]
        : [{ step: "horizon.root", ok: true, attempts: status === "degraded" ? 2 : 1, latencyMs: 5 }]
  };
}

/** A scripted runner: each journey answers from its queue (the last answer repeats). */
function scripted(script: Partial<Record<JourneyId, (HealthStatus | "throw" | "refuse")[]>>) {
  const calls: JourneyId[] = [];
  const runner: NonNullable<WorkflowMonitorOptions["runner"]> = async (_auth, journey) => {
    calls.push(journey);
    const queue = script[journey] ?? ["healthy"];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === "throw") throw new Error("probe bug");
    if (next === "refuse") return err("unknown_journey");
    return ok(report(journey, next));
  };
  return { runner, calls };
}

function monitor(script: Parameters<typeof scripted>[0], options: Partial<WorkflowMonitorOptions> = {}) {
  let clock = START;
  const { runner, calls } = scripted(script);
  return { monitor: createWorkflowMonitor({ runner, now: () => (clock += 1_000), ...options }), calls };
}

afterEach(() => resetTelemetrySink());

describe("critical workflow monitor (#410)", () => {
  describe("normal path", () => {
    it("runs every catalogue journey in order and rolls up healthy", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { monitor: workflow, calls } = monitor({});

      const outcome = await workflow.run(SERVICE, RUN);
      expect(calls).toEqual(["operation-history", "account-balances", "transaction-lookup", "fee-stats"]);
      expect(outcome.ok && outcome.value).toMatchObject({ status: "healthy", alerts: [], availability: { "fee-stats": 1 } });
      expect(sink.events.at(-1)).toMatchObject({ op: "synthetic.workflow", result: "success", payload: { status: "healthy", alerts: 0 } });
    });

    it("rolls up degraded when a journey passes slowly, without alerting", async () => {
      const { monitor: workflow } = monitor({ "account-balances": ["degraded"] });
      const outcome = await workflow.run(SERVICE, RUN);
      expect(outcome.ok && outcome.value.status).toBe("degraded");
      expect(outcome.ok && outcome.value.alerts).toEqual([]);
    });
  });

  describe("failure path: alert lifecycle", () => {
    it("does not alert on a single failure, opens on the second, resolves on recovery", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { monitor: workflow } = monitor({ "transaction-lookup": ["unhealthy", "unhealthy", "unhealthy", "healthy"] });

      const first = await workflow.run(SERVICE, RUN);
      expect(first.ok && first.value).toMatchObject({ status: "degraded", alerts: [] });

      const second = await workflow.run(SERVICE, RUN);
      expect(second.ok && second.value.status).toBe("unhealthy");
      expect(second.ok && second.value.alerts).toEqual([
        expect.objectContaining({ journey: "transaction-lookup", transition: "opened", critical: true, consecutiveRuns: 2, errorCode: "server_error" })
      ]);

      // An open alert does not re-fire while the failure continues.
      const third = await workflow.run(SERVICE, RUN);
      expect(third.ok && third.value.alerts).toEqual([]);
      expect(workflow.state().journeys.find((entry) => entry.journey === "transaction-lookup")).toMatchObject({
        alerting: true,
        consecutiveFailures: 3,
        alertSince: expect.any(String)
      });

      const fourth = await workflow.run(SERVICE, RUN);
      expect(fourth.ok && fourth.value).toMatchObject({ status: "healthy", alerts: [expect.objectContaining({ transition: "resolved" })] });
      expect(fourth.ok && fourth.value.availability["transaction-lookup"]).toBe(0.25);

      const alertEvents = sink.events.filter((event) => event.op === "synthetic.alert");
      expect(alertEvents.map((event) => (event.payload as { transition: string }).transition)).toEqual(["opened", "resolved"]);
    });

    it("only degrades the workflow when a non-critical journey alerts", async () => {
      const { monitor: workflow } = monitor({ "fee-stats": ["unhealthy"] }, { failureThreshold: 1 });
      const outcome = await workflow.run(SERVICE, RUN);
      expect(outcome.ok && outcome.value).toMatchObject({
        status: "degraded",
        alerts: [expect.objectContaining({ journey: "fee-stats", critical: false, transition: "opened" })]
      });
    });

    it("needs recoveryThreshold passing runs to resolve, and a relapse resets the count", async () => {
      const { monitor: workflow } = monitor(
        { "account-balances": ["unhealthy", "healthy", "unhealthy", "healthy", "healthy"] },
        { failureThreshold: 1, recoveryThreshold: 2, journeys: ["account-balances"] }
      );
      const transitions: string[][] = [];
      for (let run = 0; run < 5; run += 1) {
        const outcome = await workflow.run(SERVICE, RUN);
        transitions.push(outcome.ok ? outcome.value.alerts.map((alert) => alert.transition) : []);
      }
      expect(transitions).toEqual([["opened"], [], [], [], ["resolved"]]);
    });

    it("isolates journeys: a throwing or refusing runner is unhealthy and the rest still run", async () => {
      const { monitor: workflow, calls } = monitor(
        { "operation-history": ["throw"], "account-balances": ["refuse"] },
        { failureThreshold: 1 }
      );
      const outcome = await workflow.run(SERVICE, RUN);

      expect(calls).toHaveLength(4);
      expect(outcome.ok && outcome.value.alerts.map((alert) => [alert.journey, alert.errorCode])).toEqual([
        ["operation-history", "probe_crashed"],
        ["account-balances", "unknown_journey"]
      ]);
      expect(outcome.ok && outcome.value.status).toBe("unhealthy");
    });

    it("keeps at most historySize runs per journey", async () => {
      const { monitor: workflow } = monitor({}, { historySize: 3, journeys: ["fee-stats"] });
      for (let run = 0; run < 5; run += 1) await workflow.run(SERVICE, RUN);
      expect(workflow.state().journeys[0].history).toHaveLength(3);
    });
  });

  describe("retry path: state carried between runs", () => {
    it("round-trips its state, so a stateless scheduler keeps alert continuity", async () => {
      const first = monitor({ "transaction-lookup": ["unhealthy"] }).monitor;
      await first.run(SERVICE, RUN);
      const saved = JSON.parse(JSON.stringify(first.state()));
      expect(saved.version).toBe(WORKFLOW_STATE_VERSION);

      const second = monitor({ "transaction-lookup": ["unhealthy"] }).monitor;
      expect(second.importState(saved)).toEqual(ok(true));
      const outcome = await second.run(SERVICE, RUN);
      expect(outcome.ok && outcome.value.alerts).toEqual([expect.objectContaining({ journey: "transaction-lookup", transition: "opened" })]);
    });

    it.each([
      ["null", null],
      ["a future version", { version: WORKFLOW_STATE_VERSION + 1, journeys: [] }],
      ["a negative counter", { version: 1, journeys: [{ journey: "fee-stats", alerting: false, consecutiveFailures: -1, consecutiveSuccesses: 0, history: [] }] }],
      ["a bad history status", { version: 1, journeys: [{ journey: "fee-stats", alerting: false, consecutiveFailures: 0, consecutiveSuccesses: 0, history: [{ at: "2026-11-21T00:00:00Z", status: "fine", durationMs: 1 }] }] }],
      ["an unreadable alertSince", { version: 1, journeys: [{ journey: "fee-stats", alerting: true, alertSince: "soon", consecutiveFailures: 2, consecutiveSuccesses: 0, history: [] }] }]
    ])("refuses %s and keeps its current state", async (_, state) => {
      const { monitor: workflow } = monitor({ "fee-stats": ["unhealthy"] }, { journeys: ["fee-stats"] });
      await workflow.run(SERVICE, RUN);
      const before = workflow.state();

      expect(workflow.importState(state)).toEqual(err("workflow_state_invalid"));
      expect(workflow.state()).toEqual(before);
    });

    it("ignores journeys that left the catalogue and trims history to its own limit", () => {
      const { monitor: workflow } = monitor({}, { historySize: 1, journeys: ["fee-stats"] });
      const history = [1, 2].map((n) => ({ at: new Date(START + n).toISOString(), status: "healthy", durationMs: n }));
      expect(
        workflow.importState({
          version: 1,
          journeys: [
            { journey: "retired-journey", alerting: true },
            { journey: "fee-stats", alerting: false, consecutiveFailures: 0, consecutiveSuccesses: 2, history }
          ]
        })
      ).toEqual(ok(true));
      expect(workflow.state().journeys[0].history).toEqual([history[1]]);
    });
  });

  describe("authorization path", () => {
    it("refuses a viewer before running any journey", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { monitor: workflow, calls } = monitor({});

      expect(await workflow.run({ role: "viewer" }, RUN)).toEqual(err("synthetic_unauthorized"));
      expect(calls).toEqual([]);
      expect(sink.events.at(-1)).toMatchObject({ op: "synthetic.workflow", errorCode: "synthetic_unauthorized" });
    });

    it("refuses invalid configuration up front", () => {
      expect(() => createWorkflowMonitor({ failureThreshold: 0 })).toThrow(RangeError);
      expect(() => createWorkflowMonitor({ historySize: Number.NaN })).toThrow(RangeError);
      expect(() => createWorkflowMonitor({ journeys: [] })).toThrow(RangeError);
      expect(() => createWorkflowMonitor({ journeys: ["nope" as JourneyId] })).toThrow(RangeError);
    });
  });
});
