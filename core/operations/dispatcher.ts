import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";

export type DispatchStatus = "queued" | "running" | "succeeded" | "dead_lettered" | "rolled_back" | "rollback_failed";
export interface DispatchJob<T = unknown> { readonly id: string; readonly operation: string; readonly idempotencyKey: string; readonly payload: T; readonly attempts: number; readonly status: DispatchStatus; readonly lastError?: string; readonly rollbackAttempts?: number; }
export interface DispatchStore<T = unknown> { read(id: string): DispatchJob<T> | undefined; write(job: DispatchJob<T>): void; list(): readonly DispatchJob<T>[]; }
export interface SideEffectDispatcherOptions<T> { readonly store: DispatchStore<T>; readonly maxAttempts?: number; readonly newId?: () => string; }

export function createSideEffectDispatcher<T>({ store, maxAttempts = 3, newId = () => crypto.randomUUID() }: SideEffectDispatcherOptions<T>) {
  const byKey = (key: string) => store.list().find((job) => job.idempotencyKey === key);
  const submit = (input: { operation: string; idempotencyKey: string; payload: T }) => {
    const existing = byKey(input.idempotencyKey);
    if (existing) return { job: existing, replayed: true };
    const job: DispatchJob<T> = { ...input, id: newId(), attempts: 0, status: "queued" };
    store.write(job); return { job, replayed: false };
  };
  const run = async (id: string, effect: (job: DispatchJob<T>) => Promise<void> | void) => {
    const current = store.read(id); if (!current || current.status === "succeeded" || current.status === "dead_lettered" || current.status === "rolled_back") return current;
    const running = { ...current, status: "running" as const, attempts: current.attempts + 1 }; store.write(running);
    try { await effect(running); const done = { ...running, status: "succeeded" as const }; store.write(done); return done; }
    catch (error) { const failed = { ...running, status: running.attempts >= maxAttempts ? "dead_lettered" as const : "queued" as const, lastError: error instanceof Error ? error.message : String(error) }; store.write(failed); return failed; }
  };
  const replay = () => store.list().filter((job) => job.status === "queued");

  const rollback = async (id: string, undoEffect: (job: DispatchJob<T>) => Promise<void> | void): Promise<Result<DispatchJob<T>, string>> => {
    const current = store.read(id);
    if (!current) return err("job_not_found");
    if (current.status === "rolled_back") return ok(current); // Idempotent no-op

    const rollbackAttempts = (current.rollbackAttempts ?? 0) + 1;
    try {
      await undoEffect(current);
      const rolledBack: DispatchJob<T> = { ...current, status: "rolled_back" as const, rollbackAttempts };
      store.write(rolledBack);
      return ok(rolledBack);
    } catch (error) {
      const failed: DispatchJob<T> = {
        ...current,
        status: "rollback_failed" as const,
        rollbackAttempts,
        lastError: error instanceof Error ? error.message : String(error)
      };
      store.write(failed);
      return err(failed.lastError ?? "rollback_failed");
    }
  };

  const rollbackAuthorized = async (
    auth: AuthContext,
    id: string,
    undoEffect: (job: DispatchJob<T>) => Promise<void> | void
  ): Promise<Result<DispatchJob<T>, string>> => {
    if (!hasPermission(auth.role, "admin:recovery")) return err("permission_denied");
    return rollback(id, undoEffect);
  };

  return { submit, run, replay, rollback, rollbackAuthorized };
}
