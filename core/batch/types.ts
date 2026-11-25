/**
 * Types and vocabulary for bounded batch processing of large datasets.
 *
 * Designed for memory-safe processing of large datasets (ledger sweeps, batch payments,
 * transaction exports, account reconciliations) under strict resource constraints:
 * - Bounded memory: streaming / chunked consumption guarantees O(batchSize) auxiliary space.
 * - Bounded concurrency: strictly throttles simultaneous work to avoid Horizon rate limits.
 * - Deterministic checkpointing: durable cursor progression allowing resumption without re-processing.
 * - Compensation & Rollback: reversible operations can roll back committed batches in reverse order.
 */

import type { Result } from "@/core/result/result";

export type BatchFailureStrategy = "halt" | "skip" | "retry";

export interface BatchItem {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface BatchItemResult<TResult = unknown> {
  readonly itemId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly output?: TResult;
  readonly error?: string;
  readonly attempts: number;
}

export type BatchJobStatus = "in_progress" | "completed" | "failed" | "halted" | "rolled_back";

export interface BatchCheckpoint {
  readonly batchJobId: string;
  readonly lastProcessedId?: string;
  readonly cursor?: string;
  readonly processedCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly status: BatchJobStatus;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface BatchCheckpointStore {
  getCheckpoint(batchJobId: string): Promise<BatchCheckpoint | undefined> | BatchCheckpoint | undefined;
  saveCheckpoint(checkpoint: BatchCheckpoint): Promise<void> | void;
}

export interface BatchProcessOptions<TItem, TResult, TContext = unknown> {
  /** Number of items processed per batch chunk. Bounded in [1, 1000]. Defaults to 50. */
  readonly batchSize?: number;
  /** Maximum number of concurrent items processed in parallel per chunk. Bounded in [1, 20]. Defaults to 1. */
  readonly maxConcurrency?: number;
  /** Maximum allowable failures before halting the run. Defaults to 0. */
  readonly maxFailures?: number;
  /** Strategy on item failure: 'halt' stops immediately, 'skip' records failure and proceeds, 'retry' retries up to retryLimit. */
  readonly failureStrategy?: BatchFailureStrategy;
  /** Retry limit per item when failureStrategy is 'retry'. Defaults to 2. */
  readonly retryLimit?: number;
  /** Delay between retries in milliseconds. Defaults to 50ms. */
  readonly retryDelayMs?: number;
  /** Optional delay between batches to respect upstream rate limits (e.g., Horizon 429). Defaults to 0ms. */
  readonly delayBetweenBatchesMs?: number;
  /** Durable checkpoint store for resuming runs across interruptions. */
  readonly checkpointStore?: BatchCheckpointStore;
  /** Real-time progress callback emitted after each batch completes. */
  readonly onProgress?: (progress: BatchCheckpoint) => void;
  /** Injected context passed to item processor. */
  readonly context?: TContext;
  /** Injected clock for deterministic testing. */
  readonly now?: () => number;
  /** Actor identifier for auditing. */
  readonly actor?: string;
}

export interface BatchSummary<TResult = unknown> {
  readonly jobId: string;
  readonly totalItems: number;
  readonly processedCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly batchesCount: number;
  readonly durationMs: number;
  readonly results: readonly BatchItemResult<TResult>[];
  readonly status: BatchJobStatus;
  readonly lastProcessedId?: string;
  readonly error?: string;
}

export type BatchStreamReader<TItem> = (
  cursor?: string,
  limit?: number
) => Promise<{ items: readonly TItem[]; nextCursor?: string; hasMore: boolean }>;

export type BatchSource<TItem> = readonly TItem[] | BatchStreamReader<TItem>;

export interface BatchProcessor<TItem, TResult = unknown, TContext = unknown> {
  processItem(item: TItem, context?: TContext): Promise<Result<TResult, string>> | Result<TResult, string>;
  /** Optional compensation handler to roll back an item if subsequent batches fail. */
  rollbackItem?(item: TItem, result: BatchItemResult<TResult>, context?: TContext): Promise<void> | void;
}

