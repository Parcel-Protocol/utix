/**
 * App-wide maintenance jobs.
 *
 * The Horizon client cache in `core/horizon/client.ts` is memoised per
 * network. Pruning it after a network switch was previously a plain utility
 * call performed inside request handlers; it is now a registered delayed job,
 * so a switch enqueues the prune and the worker framework decides when it runs.
 */

import { resetHorizonClients } from "@/core/horizon/client";
import {
  createWorkerFramework,
  type ShutdownReport,
  type WorkerContext,
  type WorkerFramework
} from "@/core/workers/queue";

/** Prunes the memoised Horizon clients. Delayed so a rapid switch settles first. */
export const PRUNE_HORIZON_CLIENTS_OP = "maintenance.prune_horizon_clients";

/** How long after enqueueing before the prune job may run. */
export const PRUNE_HORIZON_CLIENTS_DELAY_MS = 1_000;

const PRUNE_POLICY = { retryDelayMs: PRUNE_HORIZON_CLIENTS_DELAY_MS, maxAttempts: 3 };

function registerMaintenance(framework: WorkerFramework): WorkerFramework {
  framework.register(
    PRUNE_HORIZON_CLIENTS_OP,
    (_params, context: WorkerContext) => {
      // The prune is the exact job the issue names: a maintenance side effect
      // that must not be reported as done when it was abandoned. Checking the
      // signal first means a shutdown that lands between the job being picked up
      // and the prune running leaves the memoised clients alone, and the
      // framework records the attempt as cancelled rather than succeeded.
      context.signal.throwIfAborted();
      resetHorizonClients();
    },
    PRUNE_POLICY
  );
  return framework;
}

let singleton: WorkerFramework | undefined;

/**
 * The app-wide maintenance worker framework. One instance per session so job
 * ids and dedupe behaviour stay stable. Run its due jobs with `drainDueJobs()`.
 */
export function getMaintenanceFramework(): WorkerFramework {
  if (!singleton) singleton = registerMaintenance(createWorkerFramework());
  return singleton;
}

/** Creates a fresh, registered framework — the hook used by tests and the CLI runner. */
export function createMaintenanceFramework(): WorkerFramework {
  return registerMaintenance(createWorkerFramework());
}

/**
 * Cancels in-flight maintenance work and reports what each job was doing.
 *
 * Call this before the app tears down. The report is what a caller needs in
 * order to know whether a prune still has to happen: a job listed as
 * `interrupted` may have been abandoned mid-flight, while one in `pending` was
 * never started and will be picked up by the next session.
 */
export async function shutdownMaintenance(
  framework: WorkerFramework = getMaintenanceFramework()
): Promise<ShutdownReport> {
  return framework.shutdown({ reason: "maintenance_shutdown" });
}

/** Aborts without waiting, for an unload handler that cannot await. */
export function cancelMaintenance(reason = "maintenance_cancel"): void {
  getMaintenanceFramework().cancel(reason);
}
