import { describe, expect, it } from "vitest";
import { err, ok } from "@/core/result/result";
import { createIdempotencyStore } from "../idempotency";
import {
  authorizeSubmission,
  runDuplicateSubmissionRetry,
  runDuplicateSubmissionScenario
} from "../duplicate-submission";

const MAINTAINER = { role: "maintainer" } as const;
const VIEWER = { role: "viewer" } as const;
const GRANTED = { role: "viewer", permissions: ["ops:submit"] } as const;

describe("Duplicate submission concurrency boundary (#456)", () => {
  it("normal path: concurrent copies execute the side effect once", async () => {
    const store = createIdempotencyStore();
    let executions = 0;

    const report = await runDuplicateSubmissionScenario<string>({
      store,
      key: "submit-1",
      operation: "transfer",
      request: { amount: 1 },
      actor: MAINTAINER,
      concurrency: 8,
      run: async () => {
        executions += 1;
        return ok("receipt-1");
      }
    });

    expect(report.authorized).toBe(true);
    expect(report.attempts).toBe(8);
    expect(report.executions).toBe(1);
    expect(executions).toBe(1);
    expect(report.value).toBe("receipt-1");
    expect(report.inFlight + report.replays).toBe(7);
    expect(report.conflicts).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it("normal path: a later duplicate replays without executing", async () => {
    const store = createIdempotencyStore();
    let executions = 0;
    const base = {
      store,
      key: "submit-2",
      operation: "transfer",
      request: { amount: 2 },
      actor: MAINTAINER,
      run: async () => {
        executions += 1;
        return ok("receipt-2");
      }
    };

    const first = await runDuplicateSubmissionScenario<string>({ ...base, concurrency: 1 });
    const second = await runDuplicateSubmissionScenario<string>({ ...base, concurrency: 3 });

    expect(first.executions).toBe(1);
    expect(second.executions).toBe(0);
    expect(second.replays).toBeGreaterThan(0);
    expect(second.value).toBe("receipt-2");
    expect(executions).toBe(1);
  });

  it("failure path: a recorded failure is replayed, not re-executed", async () => {
    const store = createIdempotencyStore();
    let executions = 0;
    const base = {
      store,
      key: "submit-failed",
      operation: "transfer",
      request: { amount: 3 },
      actor: MAINTAINER
    };

    const first = await runDuplicateSubmissionScenario<string>({
      ...base,
      run: async () => {
        executions += 1;
        return err("upstream_failed");
      }
    });
    const replay = await runDuplicateSubmissionScenario<string>({
      ...base,
      run: async () => {
        executions += 1;
        return ok("unexpected");
      }
    });

    expect(first.executions).toBe(1);
    expect(first.failures).toContain("upstream_failed");
    expect(replay.executions).toBe(0);
    expect(replay.failures).toContain("upstream_failed");
    expect(executions).toBe(1);
  });

  it("authorization path: an unprivileged actor claims no key", async () => {
    expect(authorizeSubmission(VIEWER).ok).toBe(false);
    const granted = authorizeSubmission(GRANTED);
    expect(granted.ok).toBe(true);

    const store = createIdempotencyStore();
    const base = {
      store,
      key: "submit-auth",
      operation: "transfer",
      request: { amount: 4 },
      run: async () => ok("receipt-4")
    };

    const denied = await runDuplicateSubmissionScenario<string>({ ...base, actor: VIEWER });
    expect(denied.authorized).toBe(false);
    expect(denied.executions).toBe(0);
    expect(denied.failures).toContain("duplicate_submission_unauthorized");

    const allowed = await runDuplicateSubmissionScenario<string>({ ...base, actor: GRANTED });
    expect(allowed.authorized).toBe(true);
    expect(allowed.executions).toBe(1);
  });

  it("retry path: a failed attempt recovers under a derived key", async () => {
    const store = createIdempotencyStore();
    const report = await runDuplicateSubmissionRetry<string>({
      store,
      key: "submit-retry",
      operation: "transfer",
      request: { amount: 5 },
      actor: MAINTAINER,
      failedRun: async () => err("temporary_outage"),
      recoveredRun: async () => ok("recovered")
    });

    expect(report.retryKey).toBe("submit-retry:retry");
    expect(report.first.failures).toContain("temporary_outage");
    expect(report.second.executions).toBe(1);
    expect(report.second.value).toBe("recovered");
    expect(report.recovered).toBe(true);
    expect(report.totalExecutions).toBe(2);
  });
});
