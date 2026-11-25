import { describe, expect, it } from "vitest";
import { err, ok } from "@/core/result/result";
import {
  createIdempotencyStore,
  isValidIdempotencyKey,
  withIdempotency
} from "@/core/idempotency/idempotency";
import { runDuplicateSubmissionScenario } from "../duplicate-submission";

const OPERATION = "submit:transfer";
const MAINTAINER = { role: "maintainer" } as const;

function storeAt(start: number, ttlMs?: number) {
  let clock = start;
  const store = createIdempotencyStore({ now: () => clock, ...(ttlMs ? { ttlMs } : {}) });
  return { store, advance: (ms: number) => { clock += ms; } };
}

describe("Concurrency — duplicate submissions and stale versions (#456)", () => {
  describe("Duplicate submission detection", () => {
    it("detects identical submissions with the same idempotency key", async () => {
      const { store } = storeAt(0);
      const request = { amount: 100 };
      let runs = 0;

      const first = await withIdempotency(store, {
        key: "payment-key-1",
        operation: OPERATION,
        request,
        run: () => {
          runs += 1;
          return ok({ amount: 100 });
        }
      });
      const second = await withIdempotency(store, {
        key: "payment-key-1",
        operation: OPERATION,
        request,
        run: () => {
          runs += 1;
          return ok({ amount: 100 });
        }
      });

      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.replayed).toBe(false);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.replayed).toBe(true);
        expect(second.value.value).toEqual({ amount: 100 });
      }
      expect(runs).toBe(1);
    });

    it("prevents a duplicate inside the TTL window", async () => {
      const { store, advance } = storeAt(0);
      const options = { key: "ttl-window", operation: OPERATION, request: { amount: 50 } };
      await withIdempotency(store, { ...options, run: () => ok("done") });
      advance(60 * 60 * 1000);
      const replay = await withIdempotency(store, { ...options, run: () => ok("done") });

      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.value.replayed).toBe(true);
    });

    it("detects concurrent submissions of the same request", async () => {
      const { store } = storeAt(0);
      let runs = 0;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          withIdempotency(store, {
            key: "concurrent-key",
            operation: OPERATION,
            request: { operation: "mint" },
            run: () => {
              runs += 1;
              return ok("minted");
            }
          })
        )
      );

      expect(runs).toBe(1);
      expect(results.filter((result) => result.ok).length).toBe(1);
      expect(results.filter((result) => !result.ok).length).toBe(4);

      const late = await withIdempotency(store, {
        key: "concurrent-key",
        operation: OPERATION,
        request: { operation: "mint" },
        run: () => ok("minted")
      });
      expect(late.ok).toBe(true);
      if (late.ok) expect(late.value.replayed).toBe(true);
    });

    it("allows different keys for different submissions", async () => {
      const { store } = storeAt(0);
      const first = await withIdempotency(store, {
        key: "key-1",
        operation: OPERATION,
        request: { amount: 100 },
        run: () => ok("a")
      });
      const second = await withIdempotency(store, {
        key: "key-2",
        operation: OPERATION,
        request: { amount: 100 },
        run: () => ok("b")
      });

      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value.replayed).toBe(false);
        expect(second.value.replayed).toBe(false);
        expect(first.value.value).not.toBe(second.value.value);
      }
    });

    it("rejects duplicate keys with conflicting payloads", async () => {
      const { store } = storeAt(0);
      const first = await withIdempotency(store, {
        key: "conflict-key",
        operation: OPERATION,
        request: { amount: 100 },
        run: () => ok("first")
      });
      const second = await withIdempotency(store, {
        key: "conflict-key",
        operation: OPERATION,
        request: { amount: 200 },
        run: () => ok("second")
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("idempotency_key_conflict");
    });
  });

  describe("Stale version handling", () => {
    it("treats an expired key as stale instead of replaying it", async () => {
      const { store, advance } = storeAt(0, 1000);
      const options = { key: "stale-key", operation: OPERATION, request: { version: 1 } };
      const first = await withIdempotency(store, { ...options, run: () => ok("v1") });
      expect(first.ok).toBe(true);

      advance(1001);
      const stale = await withIdempotency(store, { ...options, run: () => ok("v1") });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe("idempotency_key_expired");
    });

    it("allows a corrected retry on a fresh key", async () => {
      const { store } = storeAt(0);
      const first = await withIdempotency(store, {
        key: "version-key-1",
        operation: OPERATION,
        request: { status: "draft", version: 1 },
        run: () => ok("v1")
      });
      const next = await withIdempotency(store, {
        key: "version-key-2",
        operation: OPERATION,
        request: { status: "draft", version: 2 },
        run: () => ok("v2")
      });

      expect(first.ok).toBe(true);
      expect(next.ok).toBe(true);
      if (next.ok) expect(next.value.value).toBe("v2");
    });
  });

  describe("Race condition tests", () => {
    it("handles near-simultaneous submissions on different keys", async () => {
      const { store } = storeAt(0);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          withIdempotency(store, {
            key: `parallel-${index}`,
            operation: OPERATION,
            request: { id: index },
            run: () => ok(index)
          })
        )
      );

      expect(results.every((result) => result.ok)).toBe(true);
    });

    it("executes once under high contention", async () => {
      const { store } = storeAt(0);
      let runs = 0;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          withIdempotency(store, {
            key: "high-contention",
            operation: OPERATION,
            request: { amount: 100 },
            run: () => {
              runs += 1;
              return ok("settled");
            }
          })
        )
      );

      expect(runs).toBe(1);
      expect(results.filter((result) => result.ok).length).toBe(1);
    });
  });

  describe("Authorization paths for deduplication", () => {
    it("does not let an unauthorized actor consume a key", async () => {
      const { store } = storeAt(0);
      const denied = await runDuplicateSubmissionScenario<string>({
        store,
        key: "alice-key",
        operation: OPERATION,
        request: { owner: "alice" },
        actor: { role: "viewer" },
        run: () => ok("alice")
      });

      expect(denied.authorized).toBe(false);
      expect(denied.executions).toBe(0);

      const allowed = await runDuplicateSubmissionScenario<string>({
        store,
        key: "alice-key",
        operation: OPERATION,
        request: { owner: "alice" },
        actor: MAINTAINER,
        run: () => ok("alice")
      });
      expect(allowed.authorized).toBe(true);
      expect(allowed.executions).toBe(1);
    });

    it("rejects a conflicting owner on a claimed key", async () => {
      const { store } = storeAt(0);
      const first = await withIdempotency(store, {
        key: "shared-key",
        operation: OPERATION,
        request: { owner: "alice" },
        run: () => ok("alice")
      });
      const second = await withIdempotency(store, {
        key: "shared-key",
        operation: OPERATION,
        request: { owner: "bob" },
        run: () => ok("bob")
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("idempotency_key_conflict");
    });
  });

  describe("Failure modes", () => {
    it("handles invalid idempotency keys", async () => {
      const { store } = storeAt(0);
      expect(isValidIdempotencyKey("")).toBe(false);
      const result = await withIdempotency(store, {
        key: "",
        operation: OPERATION,
        run: () => ok("never")
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("idempotency_key_invalid");
    });

    it("replays a recorded failure instead of repeating the side effect", async () => {
      const { store } = storeAt(0);
      let runs = 0;
      const options = { key: "failed-key", operation: OPERATION, request: { amount: 1 } };

      const first = await withIdempotency(store, {
        ...options,
        run: () => {
          runs += 1;
          return err("upstream_failed");
        }
      });
      const retry = await withIdempotency(store, {
        ...options,
        run: () => {
          runs += 1;
          return ok("unexpected");
        }
      });

      expect(first.ok).toBe(false);
      expect(retry.ok).toBe(false);
      expect(runs).toBe(1);
      if (!retry.ok) expect(retry.code).toBe("upstream_failed");
    });

    it("releases a stuck claim so a corrected retry can reuse the key", async () => {
      const { store } = storeAt(0);
      const begun = store.begin({ key: "stuck-key", operation: OPERATION, request: { amount: 1 } });
      expect(begun.ok).toBe(true);

      const blocked = await withIdempotency(store, {
        key: "stuck-key",
        operation: OPERATION,
        request: { amount: 1 },
        run: () => ok("never")
      });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe("idempotency_in_flight");

      const released = store.abandon("stuck-key");
      expect(released.ok).toBe(true);
      const retry = await withIdempotency(store, {
        key: "stuck-key",
        operation: OPERATION,
        request: { amount: 1 },
        run: () => ok("recovered")
      });
      expect(retry.ok).toBe(true);
      if (retry.ok) expect(retry.value.replayed).toBe(false);
    });
  });
});
