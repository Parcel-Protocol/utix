// Resumable orphan‑repair command with checkpointing.
// This is a simplified implementation that processes records in batches
// and writes a checkpoint after each successful batch.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Path where checkpoint data is stored (relative to project root).
const CHECKPOINT_FILE = resolve(process.cwd(), "core/orphan-repair/checkpoint.json");

interface Checkpoint {
  lastProcessedId?: string; // ID of the last record fully processed
  processedCount: number;
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    try {
      const raw = readFileSync(CHECKPOINT_FILE, "utf8");
      return JSON.parse(raw) as Checkpoint;
    } catch (_) {
      // fall back to empty checkpoint if corrupted
    }
  }
  return { processedCount: 0 };
}

function saveCheckpoint(cp: Checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2) + "\n", "utf8");
}

// Placeholder: fetch orphaned records. In the real codebase this would query the DB.
async function fetchOrphanedRecords(sinceId?: string) {
  // Simulated static list of record IDs.
  const all = ["r1", "r2", "r3", "r4", "r5"];
  if (!sinceId) return all;
  const idx = all.indexOf(sinceId) + 1;
  return all.slice(idx);
}

// Placeholder repair action – could fail randomly to test retry logic.
async function repairRecord(id: string) {
  // Simulate async work
  await new Promise((res) => setTimeout(res, 10));
  if (id === "r3") {
    // Simulated transient error on r3 that succeeds on retry
    if (!process.env.RETRY_R3) {
      process.env.RETRY_R3 = "1";
      throw new Error("Transient failure on r3");
    }
  }
  // Assume success otherwise
}

async function run() {
  const checkpoint = loadCheckpoint();
  const records = await fetchOrphanedRecords(checkpoint.lastProcessedId);
  console.log(`Processing ${records.length} orphaned records`);

  for (const id of records) {
    try {
      await repairRecord(id);
      // Update checkpoint after each successful repair
      checkpoint.lastProcessedId = id;
      checkpoint.processedCount++;
      saveCheckpoint(checkpoint);
      console.log(`Repaired ${id}`);
    } catch (e) {
      console.error(`Failed to repair ${id}:`, e);
      // Abort on error – next run will resume from the same id
      process.exit(1);
    }
  }
  console.log("Orphan‑repair completed");
}

if (import.meta.url === process.argv[1]) {
  run();
}
