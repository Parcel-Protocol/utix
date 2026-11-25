/**
 * Duplicate-submission concurrency coverage (#456).
 *
 * The idempotency store already guarantees that a claimed key is executed
 * once. This module does not change that contract — it makes the guarantee
 * executable and observable. A vertical slice that can only be tested by
 * reading the store internals is a slice that will regress silently.
 *
 * `runDuplicateSubmissionScenario` fires several logically identical attempts
 * at one key and counts what actually happened: executions, replays, in-flight
 * rejections, conflicts and recorded failures. Authorization is checked before
 * a key is claimed, so an unprivileged caller cannot consume one.
 *
 * `runDuplicateSubmissionRetry` covers the recovery path: a failed attempt is
 * recorded (a retry on the same key replays that failure by design), so a real
 * retry uses a derived key and must execute exactly once more.
 *
 * No side effect is rolled back here. The rollback guarantee is that a
 * duplicate never starts a second side effect; recovery is a new, separately
 * keyed attempt.
 */

import { err, ok, type Result } from "@/core/result/result";
import {
  withIdempotency,
  type IdempotentOutcome,
  type IdempotencyStore
} from "./idempotency";

export const DUPLICATE_SUBMISSION_PERMISSION = "ops:submit";

export interface SubmissionActor {
  readonly role: string;
  readonly id?: string;
  readonly permissions?: readonly string[];
}

export type SubmissionAuthorizationErrorCode = "duplicate_submission_unauthorized";

/** Maintainers and services submit directly; other roles need an explicit grant. */
export function authorizeSubmission(actor: SubmissionActor): Result<true, SubmissionAuthorizationErrorCode> {
  if (actor.role === "maintainer" || actor.role === "service") return ok(true);
  if ((actor.permissions ?? []).includes(DUPLICATE_SUBMISSION_PERMISSION)) return ok(true);
  return err("duplicate_submission_unauthorized");
}

export interface DuplicateSubmissionReport<T> {
  readonly authorized: boolean;
  readonly attempts: number;
  /** How many times the supplied side-effect function was actually invoked. */
  readonly executions: number;
  readonly replays: number;
  readonly inFlight: number;
  readonly conflicts: number;
  readonly failures: readonly string[];
  readonly value?: T;
}

export interface DuplicateSubmissionRequest<T> {
  readonly store: IdempotencyStore;
  readonly key: string | undefined;
  readonly operation: string;
  readonly request?: unknown;
  readonly actor: SubmissionActor;
  readonly run: () => Result<T, string> | Promise<Result<T, string>>;
  /** Clamped to 1–64. Defaults to 4. */
  readonly concurrency?: number;
}

function boundedConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(64, Math.floor(value as number)));
}

/**
 * Run `concurrency` identical attempts against one idempotency key. Because
 * `begin` claims the key synchronously, exactly one attempt should execute;
 * the rest are reported as in-flight or replayed according to when they land.
 */
export async function runDuplicateSubmissionScenario<T>(
  input: DuplicateSubmissionRequest<T>
): Promise<DuplicateSubmissionReport<T>> {
  const attempts = boundedConcurrency(input.concurrency);
  const authorization = authorizeSubmission(input.actor);
  if (!authorization.ok) {
    return {
      authorized: false,
      attempts,
      executions: 0,
      replays: 0,
      inFlight: 0,
      conflicts: 0,
      failures: [authorization.code]
    };
  }

  let executions = 0;
  let replays = 0;
  let inFlight = 0;
  let conflicts = 0;
  const failures: string[] = [];
  let value: T | undefined;

  const outcomes = await Promise.allSettled(
    Array.from({ length: attempts }, () =>
      withIdempotency<T>(input.store, {
        key: input.key,
        operation: input.operation,
        request: input.request,
        run: async () => {
          executions += 1;
          return input.run();
        }
      })
    )
  );

  for (const settled of outcomes) {
    if (settled.status === "rejected") {
      failures.push("duplicate_submission_crashed");
      continue;
    }
    const result: Result<IdempotentOutcome<T>, string> = settled.value;
    if (result.ok) {
      if (result.value.replayed) {
        replays += 1;
        if (value === undefined) value = result.value.value;
      } else {
        value = result.value.value;
      }
      continue;
    }
    switch (result.code) {
      case "idempotency_in_flight":
        inFlight += 1;
        break;
      case "idempotency_key_conflict":
        conflicts += 1;
        break;
      default:
        failures.push(result.code);
    }
  }

  return {
    authorized: true,
    attempts,
    executions,
    replays,
    inFlight,
    conflicts,
    failures,
    ...(value === undefined ? {} : { value })
  };
}

export interface DuplicateSubmissionRetryRequest<T> {
  readonly store: IdempotencyStore;
  readonly key: string;
  readonly operation: string;
  readonly request?: unknown;
  readonly actor: SubmissionActor;
  readonly failedRun: () => Result<T, string> | Promise<Result<T, string>>;
  readonly recoveredRun: () => Result<T, string> | Promise<Result<T, string>>;
}

export interface DuplicateSubmissionRetryReport<T> {
  readonly retryKey: string;
  readonly first: DuplicateSubmissionReport<T>;
  readonly second: DuplicateSubmissionReport<T>;
  readonly recovered: boolean;
  readonly totalExecutions: number;
}

/**
 * Cover the retry/rollback path. A recorded failure is intentionally replayed
 * on its original key, so the retry uses a derived key rather than pretending
 * the first attempt never happened.
 */
export async function runDuplicateSubmissionRetry<T>(
  input: DuplicateSubmissionRetryRequest<T>
): Promise<DuplicateSubmissionRetryReport<T>> {
  const retryKey = `${input.key}:retry`;
  const common = {
    store: input.store,
    operation: input.operation,
    request: input.request,
    actor: input.actor,
    concurrency: 2
  };

  const first = await runDuplicateSubmissionScenario<T>({
    ...common,
    key: input.key,
    run: input.failedRun
  });
  const second = await runDuplicateSubmissionScenario<T>({
    ...common,
    key: retryKey,
    run: input.recoveredRun
  });

  return {
    retryKey,
    first,
    second,
    recovered: second.authorized && second.executions === 1 && second.failures.length === 0,
    totalExecutions: first.executions + second.executions
  };
}
