/**
 * Synthetic monitoring for critical workflows (#410)
 *
 * A single synthetic run says "this journey failed just now". Operators need
 * "this workflow is down and stays down", without being paged for one blip.
 * The workflow monitor runs the journey catalogue (#368) as one workflow and
 * keeps per-journey alert state across runs:
 *
 * - an alert **opens** after `failureThreshold` consecutive `unhealthy` runs
 *   (default 2), so one transient failure that the in-run retries could not
 *   absorb does not page anyone;
 * - an open alert **resolves** after `recoveryThreshold` consecutive passing
 *   runs (default 1); `degraded` counts as passing for alerting but is
 *   surfaced in the rollup;
 * - each journey is isolated: one journey failing, or its runner throwing,
 *   never stops the others;
 * - journeys run sequentially, so a run never bursts Horizon's rate limit.
 *
 * Rollup status: `unhealthy` while any *critical* journey's alert is open;
 * `degraded` while a non-critical alert is open or any journey's last run was
 * not `healthy`; otherwise `healthy`.
 *
 * State is in memory and can be exported/imported as versioned JSON, so a
 * stateless scheduler (cron, CI) can carry it between runs. An unreadable or
 * future-version state is refused with `workflow_state_invalid` and the
 * monitor starts fresh, which can only delay an alert by `failureThreshold`
 * runs, never invent one.
 *
 * Authorization: `admin:health`, checked once before any journey runs.
 *
 * Complexity: one run is O(journeys) journey runs; state is
 * O(journeys × historySize) and never grows past it.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import type { HealthStatus } from "@/core/health/types";
import type { StellarNetwork } from "@/core/network/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import {
  isJourneyId,
  JOURNEY_IDS,
  JOURNEYS,
  runJourney,
  type JourneyErrorCode,
  type JourneyId,
  type JourneyOptions,
  type JourneyReport
} from "./journeys";
import { firstFailure } from "./probe";

export const WORKFLOW_STATE_VERSION = 1;

export type WorkflowErrorCode = "synthetic_unauthorized" | "workflow_state_invalid";

export interface WorkflowMonitorOptions {
  /** Consecutive unhealthy runs that open an alert. Default 2. */
  readonly failureThreshold?: number;
  /** Consecutive passing runs that resolve an open alert. Default 1. */
  readonly recoveryThreshold?: number;
  /** Runs remembered per journey. Default 20. */
  readonly historySize?: number;
  /** Journeys in this workflow. Default: the whole catalogue. */
  readonly journeys?: readonly JourneyId[];
  /** Injected journey runner, for tests. */
  readonly runner?: (auth: AuthContext, journey: JourneyId, options: JourneyOptions) => Promise<Result<JourneyReport, JourneyErrorCode>>;
  readonly now?: () => number;
}

export interface JourneyRunRecord {
  readonly at: string;
  readonly status: HealthStatus;
  readonly durationMs: number;
  readonly correlationId?: string;
  readonly failedStep?: string;
  readonly errorCode?: string;
}

export interface JourneyAlertState {
  readonly journey: JourneyId;
  readonly alerting: boolean;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  /** When the current alert opened. */
  readonly alertSince?: string;
  /** Oldest first, at most `historySize`. */
  readonly history: readonly JourneyRunRecord[];
}

export interface WorkflowState {
  readonly version: typeof WORKFLOW_STATE_VERSION;
  readonly journeys: readonly JourneyAlertState[];
}

export type AlertTransition = "opened" | "resolved";

export interface AlertEvent {
  readonly journey: JourneyId;
  readonly transition: AlertTransition;
  readonly critical: boolean;
  readonly at: string;
  readonly consecutiveRuns: number;
  readonly errorCode?: string;
}

export interface JourneyWorkflowResult {
  readonly journey: JourneyId;
  readonly critical: boolean;
  readonly status: HealthStatus;
  readonly alerting: boolean;
  readonly report?: JourneyReport;
}

export interface WorkflowReport {
  readonly network: StellarNetwork;
  readonly status: HealthStatus;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly journeys: readonly JourneyWorkflowResult[];
  readonly alerts: readonly AlertEvent[];
  /** Success rate (healthy or degraded) over each journey's remembered history, 0–1. */
  readonly availability: Readonly<Partial<Record<JourneyId, number>>>;
}

export interface WorkflowMonitor {
  run(auth: AuthContext, options: JourneyOptions): Promise<Result<WorkflowReport, WorkflowErrorCode>>;
  state(): WorkflowState;
  /** Replaces the in-memory state. Refuses a malformed or newer state without touching the current one. */
  importState(state: unknown): Result<true, WorkflowErrorCode>;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, received ${value}`);
  }
}

interface MutableAlertState {
  alerting: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  alertSince?: string;
  history: JourneyRunRecord[];
}

const STATUSES: readonly HealthStatus[] = ["healthy", "degraded", "unhealthy"];

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRecord(value: unknown): JourneyRunRecord | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) return null;
  if (!STATUSES.includes(record.status as HealthStatus) || !isCount(record.durationMs)) return null;
  for (const key of ["correlationId", "failedStep", "errorCode"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") return null;
  }
  return {
    at: record.at,
    status: record.status as HealthStatus,
    durationMs: record.durationMs as number,
    ...(record.correlationId === undefined ? {} : { correlationId: record.correlationId as string }),
    ...(record.failedStep === undefined ? {} : { failedStep: record.failedStep as string }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode as string })
  };
}

export function createWorkflowMonitor(options: WorkflowMonitorOptions = {}): WorkflowMonitor {
  const failureThreshold = options.failureThreshold ?? 2;
  const recoveryThreshold = options.recoveryThreshold ?? 1;
  const historySize = options.historySize ?? 20;
  requirePositiveInteger("failureThreshold", failureThreshold);
  requirePositiveInteger("recoveryThreshold", recoveryThreshold);
  requirePositiveInteger("historySize", historySize);
  const journeys = [...new Set(options.journeys ?? JOURNEY_IDS)];
  if (journeys.length === 0 || !journeys.every(isJourneyId)) {
    throw new RangeError("journeys must be a non-empty list of catalogue journey ids");
  }
  const runner = options.runner ?? runJourney;
  const now = options.now ?? (() => Date.now());

  let alerts = new Map<JourneyId, MutableAlertState>();
  const fresh = (): MutableAlertState => ({ alerting: false, consecutiveFailures: 0, consecutiveSuccesses: 0, history: [] });
  const stateOf = (journey: JourneyId) => {
    let state = alerts.get(journey);
    if (!state) alerts.set(journey, (state = fresh()));
    return state;
  };

  function state(): WorkflowState {
    return {
      version: WORKFLOW_STATE_VERSION,
      journeys: journeys.map((journey) => {
        const current = stateOf(journey);
        return {
          journey,
          alerting: current.alerting,
          consecutiveFailures: current.consecutiveFailures,
          consecutiveSuccesses: current.consecutiveSuccesses,
          ...(current.alertSince === undefined ? {} : { alertSince: current.alertSince }),
          history: [...current.history]
        };
      })
    };
  }

  function importState(input: unknown): Result<true, WorkflowErrorCode> {
    if (input === null || typeof input !== "object") return err("workflow_state_invalid");
    const { version, journeys: entries } = input as Record<string, unknown>;
    // A newer version may mean something this code cannot read; never guess.
    if (version !== WORKFLOW_STATE_VERSION || !Array.isArray(entries)) return err("workflow_state_invalid");

    const next = new Map<JourneyId, MutableAlertState>();
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") return err("workflow_state_invalid");
      const candidate = entry as Record<string, unknown>;
      // A journey dropped from the catalogue is ignored rather than refused, so
      // removing one is not a breaking change for stored state.
      if (!isJourneyId(candidate.journey)) continue;
      if (typeof candidate.alerting !== "boolean" || !isCount(candidate.consecutiveFailures) || !isCount(candidate.consecutiveSuccesses)) {
        return err("workflow_state_invalid");
      }
      if (candidate.alertSince !== undefined && (typeof candidate.alertSince !== "string" || Number.isNaN(Date.parse(candidate.alertSince)))) {
        return err("workflow_state_invalid");
      }
      if (!Array.isArray(candidate.history)) return err("workflow_state_invalid");
      const history: JourneyRunRecord[] = [];
      for (const item of candidate.history) {
        const record = parseRecord(item);
        if (!record) return err("workflow_state_invalid");
        history.push(record);
      }
      next.set(candidate.journey, {
        alerting: candidate.alerting,
        consecutiveFailures: candidate.consecutiveFailures,
        consecutiveSuccesses: candidate.consecutiveSuccesses,
        ...(candidate.alertSince === undefined ? {} : { alertSince: candidate.alertSince as string }),
        // A smaller historySize than the one that wrote the state keeps the newest runs.
        history: history.slice(-historySize)
      });
    }
    alerts = next;
    return ok(true);
  }

  /** Applies one run to a journey's alert state; returns the transition, if any. */
  function record(journey: JourneyId, run: JourneyRunRecord): AlertTransition | undefined {
    const current = stateOf(journey);
    current.history.push(run);
    if (current.history.length > historySize) current.history.splice(0, current.history.length - historySize);

    if (run.status === "unhealthy") {
      current.consecutiveFailures += 1;
      current.consecutiveSuccesses = 0;
      if (!current.alerting && current.consecutiveFailures >= failureThreshold) {
        current.alerting = true;
        current.alertSince = run.at;
        return "opened";
      }
      return undefined;
    }

    current.consecutiveSuccesses += 1;
    current.consecutiveFailures = 0;
    if (current.alerting && current.consecutiveSuccesses >= recoveryThreshold) {
      current.alerting = false;
      delete current.alertSince;
      return "resolved";
    }
    return undefined;
  }

  async function run(auth: AuthContext, journeyOptions: JourneyOptions): Promise<Result<WorkflowReport, WorkflowErrorCode>> {
    const correlationId = newCorrelationId();
    if (!hasPermission(auth.role, "admin:health")) {
      emitTelemetry({
        op: "synthetic.workflow",
        actorType: "system",
        result: "failure",
        correlationId,
        errorCode: "synthetic_unauthorized",
        payload: { network: journeyOptions.network, role: auth.role }
      });
      return err("synthetic_unauthorized");
    }

    const started = now();
    const results: JourneyWorkflowResult[] = [];
    const events: AlertEvent[] = [];

    for (const journey of journeys) {
      const definition = JOURNEYS[journey];
      let report: JourneyReport | undefined;
      let errorCode: string | undefined;
      try {
        const outcome = await runner(auth, journey, journeyOptions);
        if (outcome.ok) report = outcome.value;
        else errorCode = outcome.code;
      } catch {
        // A runner that throws is a broken probe, not a healthy journey.
        errorCode = "probe_crashed";
      }

      const failed = report ? firstFailure(report.steps) : undefined;
      const at = new Date(now()).toISOString();
      const runRecord: JourneyRunRecord = {
        at,
        status: report?.status ?? "unhealthy",
        durationMs: Math.max(0, report?.durationMs ?? 0),
        ...(report ? { correlationId: report.correlationId } : {}),
        ...(failed ? { failedStep: failed.step } : {}),
        ...((failed?.errorCode ?? errorCode) ? { errorCode: failed?.errorCode ?? errorCode } : {})
      };
      const transition = record(journey, runRecord);
      const current = stateOf(journey);

      if (transition) {
        const event: AlertEvent = {
          journey,
          transition,
          critical: definition.critical,
          at,
          consecutiveRuns: transition === "opened" ? current.consecutiveFailures : current.consecutiveSuccesses,
          ...(runRecord.errorCode ? { errorCode: runRecord.errorCode } : {})
        };
        events.push(event);
        emitTelemetry({
          op: "synthetic.alert",
          actorType: "system",
          result: transition === "opened" ? "failure" : "success",
          correlationId,
          errorCode: transition === "opened" ? runRecord.errorCode : undefined,
          payload: { journey, transition, critical: definition.critical, network: journeyOptions.network, consecutiveRuns: event.consecutiveRuns }
        });
      }

      results.push({
        journey,
        critical: definition.critical,
        status: runRecord.status,
        alerting: current.alerting,
        ...(report ? { report } : {})
      });
    }

    const status: HealthStatus = results.some((result) => result.critical && result.alerting)
      ? "unhealthy"
      : results.some((result) => result.alerting || result.status !== "healthy")
        ? "degraded"
        : "healthy";

    const availability: Partial<Record<JourneyId, number>> = {};
    for (const journey of journeys) {
      const { history } = stateOf(journey);
      availability[journey] = history.length === 0 ? 1 : history.filter((item) => item.status !== "unhealthy").length / history.length;
    }

    const durationMs = Math.max(0, now() - started);
    emitTelemetry({
      op: "synthetic.workflow",
      actorType: "system",
      result: status === "unhealthy" ? "failure" : "success",
      latencyMs: durationMs,
      correlationId,
      payload: {
        network: journeyOptions.network,
        status,
        journeys: results.map(({ journey, status: journeyState, alerting }) => ({ journey, status: journeyState, alerting })),
        alerts: events.length
      }
    });

    return ok({
      network: journeyOptions.network,
      status,
      correlationId,
      startedAt: new Date(started).toISOString(),
      durationMs,
      journeys: results,
      alerts: events,
      availability
    });
  }

  return { run, state, importState };
}
