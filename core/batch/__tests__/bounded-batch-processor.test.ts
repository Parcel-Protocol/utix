import { describe, expect, it } from "vitest";
import {
  createMemoryCheckpointStore,
  processBoundedBatch,
  processBoundedBatchAuthorized,
  rollbackBatch,
  rollbackBatchAuthorized,
  validateBatchOptions,
  type BatchItem,
  type BatchProcessor,
  type BatchStreamReader
} from "@/core/batch";
import type { AuthContext } from "@/core/auth/middleware";
import { ok, err } from "@/core/result/result";

interface TicketItem extends BatchItem {
  id: string;
  amount: number;
}

describe("Bounded Batch Processing for Large Datasets (Issue #351)", () => {
  it("normal path: processes dataset in bounded chunks with concurrency and commits checkpoints", async () => {
    const items: TicketItem[] = Array.from({ length: 120 }, (_, i) => ({
      id: `ticket-${i + 1}`,
      amount: (i + 1) * 10
    }));

    const processedIds: string[] = [];
    const checkpointStore = createMemoryCheckpointStore();

    const processor: BatchProcessor<TicketItem, { processed: boolean }> = {
      async processItem(item) {
        processedIds.push(item.id);
        return ok({ processed: true });
      }
    };

    const result = await processBoundedBatch("job-normal-1", items, processor, {
      batchSize: 50,
      maxConcurrency: 4,
      checkpointStore
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("completed");
    expect(result.value.totalItems).toBe(120);
    expect(result.value.processedCount).toBe(120);
    expect(result.value.succeededCount).toBe(120);
    expect(result.value.failedCount).toBe(0);
    expect(result.value.batchesCount).toBe(3); // 50, 50, 20
    expect(processedIds).toHaveLength(120);

    const checkpoint = await checkpointStore.getCheckpoint("job-normal-1");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.status).toBe("completed");
    expect(checkpoint?.processedCount).toBe(120);
  });

  it("streaming reader path: streams large datasets in chunks with bounded memory consumption", async () => {
    const totalDatasetSize = 300;
    const allDataset: TicketItem[] = Array.from({ length: totalDatasetSize }, (_, i) => ({
      id: `stream-item-${i + 1}`,
      amount: i
    }));

    // Streaming reader that paginates by cursor
    const reader: BatchStreamReader<TicketItem> = async (cursor, limit = 50) => {
      const startIdx = cursor ? parseInt(cursor, 10) : 0;
      const slice = allDataset.slice(startIdx, startIdx + limit);
      const nextOffset = startIdx + slice.length;
      return {
        items: slice,
        nextCursor: String(nextOffset),
        hasMore: nextOffset < allDataset.length
      };
    };

    const processor: BatchProcessor<TicketItem, string> = {
      processItem: (item) => ok(`processed-${item.id}`)
    };

    const result = await processBoundedBatch("job-streaming-1", reader, processor, {
      batchSize: 75,
      maxConcurrency: 3
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalItems).toBe(300);
    expect(result.value.succeededCount).toBe(300);
    expect(result.value.batchesCount).toBe(4); // 75, 75, 75, 75
  });

  it("failure path: halts when failures exceed maxFailures under 'halt' strategy", async () => {
    const items: TicketItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i + 1}`,
      amount: i
    }));

    const checkpointStore = createMemoryCheckpointStore();

    const processor: BatchProcessor<TicketItem, boolean> = {
      processItem: (item) => {
        // Items 3 and 7 fail
        if (item.id === "item-3" || item.id === "item-7") {
          return err("bad_record");
        }
        return ok(true);
      }
    };

    const result = await processBoundedBatch("job-fail-1", items, processor, {
      batchSize: 10,
      maxFailures: 1, // Only 1 failure allowed
      failureStrategy: "halt",
      checkpointStore
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("halted");
    expect(result.value.failedCount).toBe(2);
    expect(result.value.error).toContain("Halted: failed count (2) exceeded threshold (1)");

    const cp = await checkpointStore.getCheckpoint("job-fail-1");
    expect(cp?.status).toBe("halted");
  });

  it("retry path: retries transiently failing items up to retryLimit", async () => {
    const items: TicketItem[] = [
      { id: "retry-1", amount: 10 },
      { id: "retry-2", amount: 20 }
    ];

    let attemptsItem1 = 0;
    const processor: BatchProcessor<TicketItem, string> = {
      processItem: (item) => {
        if (item.id === "retry-1") {
          attemptsItem1++;
          if (attemptsItem1 === 1) return err("transient_timeout");
        }
        return ok("done");
      }
    };

    const result = await processBoundedBatch("job-retry-1", items, processor, {
      batchSize: 10,
      failureStrategy: "retry",
      retryLimit: 2,
      retryDelayMs: 5
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("completed");
    expect(attemptsItem1).toBe(2);
    expect(result.value.succeededCount).toBe(2);
  });

  it("resumption path: resumes from checkpoint after interruption without duplicate execution", async () => {
    const items: TicketItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `resumable-${i + 1}`,
      amount: i
    }));

    const checkpointStore = createMemoryCheckpointStore();
    const executedItems: string[] = [];

    let haltTriggered = false;
    const flakyProcessor: BatchProcessor<TicketItem, boolean> = {
      processItem: (item) => {
        executedItems.push(item.id);
        if (item.id === "resumable-15" && !haltTriggered) {
          haltTriggered = true;
          return err("crash");
        }
        return ok(true);
      }
    };

    // First run: halts at batch 2 (batch size 10)
    await processBoundedBatch("job-resume-1", items, flakyProcessor, {
      batchSize: 10,
      maxFailures: 0,
      failureStrategy: "halt",
      checkpointStore
    });

    expect(executedItems).toContain("resumable-10");

    // Clear log and resume with healthy processor
    executedItems.length = 0;
    const healthyProcessor: BatchProcessor<TicketItem, boolean> = {
      processItem: (item) => {
        executedItems.push(item.id);
        return ok(true);
      }
    };

    const resumedResult = await processBoundedBatch("job-resume-1", items, healthyProcessor, {
      batchSize: 10,
      checkpointStore
    });

    expect(resumedResult.ok).toBe(true);
    // Should have resumed after batch 1 (items 1-10 were checkpointed as completed)
    expect(executedItems).not.toContain("resumable-1");
    expect(executedItems).not.toContain("resumable-10");
    expect(executedItems).toContain("resumable-11");
  });

  it("rollback path: compensates processed batch items in reverse LIFO order", async () => {
    const items: TicketItem[] = [
      { id: "roll-1", amount: 100 },
      { id: "roll-2", amount: 200 },
      { id: "roll-3", amount: 300 }
    ];

    const rolledBackOrder: string[] = [];
    const checkpointStore = createMemoryCheckpointStore();

    const processor: BatchProcessor<TicketItem, boolean> = {
      processItem: () => ok(true),
      rollbackItem: (item) => {
        rolledBackOrder.push(item.id);
      }
    };

    const runResult = await processBoundedBatch("job-rb-1", items, processor, {
      batchSize: 10,
      checkpointStore
    });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;

    const rbResult = await rollbackBatch("job-rb-1", items, runResult.value.results, processor, {
      checkpointStore
    });

    expect(rbResult.ok).toBe(true);
    if (!rbResult.ok) return;
    expect(rbResult.value.rolledBackCount).toBe(3);
    // LIFO rollback order: roll-3, roll-2, roll-1
    expect(rolledBackOrder).toEqual(["roll-3", "roll-2", "roll-1"]);

    const cp = await checkpointStore.getCheckpoint("job-rb-1");
    expect(cp?.status).toBe("rolled_back");
  });

  it("authorization path: enforces permissions for batch processing and rollback", async () => {
    const items: TicketItem[] = [{ id: "auth-1", amount: 50 }];
    const processor: BatchProcessor<TicketItem, boolean> = {
      processItem: () => ok(true),
      rollbackItem: () => {}
    };

    const viewerAuth: AuthContext = { role: "viewer", userId: "v-1" };
    const maintainerAuth: AuthContext = { role: "maintainer", userId: "m-1" };

    // Viewer denied
    const denied = await processBoundedBatchAuthorized(viewerAuth, "job-auth-1", items, processor);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("permission_denied");

    // Maintainer allowed
    const allowed = await processBoundedBatchAuthorized(maintainerAuth, "job-auth-1", items, processor);
    expect(allowed.ok).toBe(true);

    // Rollback auth
    const rbDenied = await rollbackBatchAuthorized(viewerAuth, "job-auth-1", items, allowed.value.results, processor);
    expect(rbDenied.ok).toBe(false);

    const rbAllowed = await rollbackBatchAuthorized(maintainerAuth, "job-auth-1", items, allowed.value.results, processor);
    expect(rbAllowed.ok).toBe(true);
  });

  it("validation: rejects invalid batchSize and maxConcurrency parameters", () => {
    expect(validateBatchOptions({ batchSize: 0 }).ok).toBe(false);
    expect(validateBatchOptions({ batchSize: 1001 }).ok).toBe(false);
    expect(validateBatchOptions({ maxConcurrency: 0 }).ok).toBe(false);
    expect(validateBatchOptions({ maxConcurrency: 25 }).ok).toBe(false);
    expect(validateBatchOptions({ maxFailures: -1 }).ok).toBe(false);
  });
});

