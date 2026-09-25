/**
 * App-wide maintenance jobs.
 *
 * The Horizon client cache in `core/horizon/client.ts` is memoised per
 * network. Pruning it after a network switch was previously a plain utility
 * call performed inside request handlers; it is now a registered delayed job,
 * so a switch enqueues the prune and the worker framework decides when it runs.
 */

import { resetHorizonClients } from "@/core/horizon/client";
import { createWorkerFramework, type WorkerFramework } from "@/core/workers/queue";

/** Prunes the memoised Horizon clients. Delayed so a rapid switch settles first. */
export const PRUNE_HORIZON_CLIENTS_OP = "maintenance.prune_horizon_clients";

/** How long after enqueueing before the prune job may run. */
export const PRUNE_HORIZON_CLIENTS_DELAY_MS = 1_000;

const PRUNE_POLICY = { retryDelayMs: PRUNE_HORIZON_CLIENTS_DELAY_MS, maxAttempts: 3 };

function registerMaintenance(framework: WorkerFramework): WorkerFramework {
  framework.register(
    PRUNE_HORIZON_CLIENTS_OP,
    () => {
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