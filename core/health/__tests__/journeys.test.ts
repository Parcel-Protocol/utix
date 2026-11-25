import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_PASSPHRASES } from "@/core/network/config";
import { createCaptureSink, resetTelemetrySink, setTelemetrySink } from "@/core/telemetry/telemetry";
import {
  isJourneyId,
  JOURNEY_IDS,
  JOURNEYS,
  runJourney,
  validateAccount,
  validateFeeStats,
  type JourneyOptions
} from "../journeys";

const HORIZON = "https://horizon.example";
const ACCOUNT = `G${"B".repeat(55)}`;
const HASH = "a".repeat(64);
const SERVICE = { role: "service" } as const;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | "transport";

const root = () => ({
  network_passphrase: NETWORK_PASSPHRASES.testnet,
  core_latest_ledger: 900,
  history_latest_ledger: 900
});

const feeStats = (overrides: Record<string, unknown> = {}) => ({
  last_ledger: "900",
  last_ledger_base_fee: "100",
  ledger_capacity_usage: "0.42",
  fee_charged: { min: "100", p10: "100", p20: "100", p30: "100", p40: "100", p50: "100", p60: "120", p70: "150", p80: "200", p90: "300", p95: "400", p99: "900", max: "1000" },
  ...overrides
});

function healthy(): Record<string, Reply[]> {
  return {
    "/": [{ body: root() }],
    "/operations": [{ body: { _embedded: { records: [{ paging_token: "9", source_account: ACCOUNT }] } } }],
    [`/accounts/${ACCOUNT}`]: [
      {
        body: {
          id: ACCOUNT,
          sequence: "38654705664",
          balances: [
            { balance: "9999.9999900", asset_type: "native" },
            { balance: "0.0000001", asset_type: "credit_alphanum4", asset_code: "USDC" }
          ]
        }
      }
    ],
    "/transactions": [{ body: { _embedded: { records: [{ hash: HASH }] } } }],
    [`/transactions/${HASH}`]: [{ body: { hash: HASH, successful: true, ledger: 900 } }],
    "/fee_stats": [{ body: feeStats() }]
  };
}

/** A scripted Horizon: each path answers from its queue (the last reply repeats). */
function horizon(routes: Record<string, Reply[]>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const queue = routes[url.pathname] ?? [{ status: 404, body: {} }];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply === "transport") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function options(fetchImpl: typeof fetch, overrides: Partial<JourneyOptions> = {}) {
  const sleeps: number[] = [];
  let clock = 0;
  return {
    sleeps,
    options: {
      network: "testnet",
      horizonUrl: HORIZON,
      fetch: fetchImpl,
      sleep: async (ms: number) => void sleeps.push(ms),
      now: () => (clock += 1),
      clock: () => Date.parse("2026-11-21T00:00:00Z"),
      ...overrides
    } satisfies JourneyOptions
  };
}

afterEach(() => resetTelemetrySink());

describe("high-value synthetic journeys (#368)", () => {
  it("catalogues each journey against an existing tool", () => {
    expect(JOURNEY_IDS).toEqual(["operation-history", "account-balances", "transaction-lookup", "fee-stats"]);
    for (const id of JOURNEY_IDS) expect(JOURNEYS[id].id).toBe(id);
    expect(isJourneyId("fee-stats")).toBe(true);
    expect(isJourneyId("__proto__")).toBe(false);
  });

  describe("normal path", () => {
    it.each([
      ["account-balances", ["/", "/operations?order=desc&limit=1", `/accounts/${ACCOUNT}`]],
      ["transaction-lookup", ["/", "/transactions?order=desc&limit=1", `/transactions/${HASH}`]],
      ["fee-stats", ["/", "/fee_stats"]]
    ] as const)("walks %s and reports healthy", async (journey, expected) => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { fetchImpl, requests } = horizon(healthy());

      const outcome = await runJourney(SERVICE, journey, options(fetchImpl).options);

      expect(outcome.ok && outcome.value).toMatchObject({ journey, status: "healthy", network: "testnet", ingestLagLedgers: 0 });
      expect(outcome.ok && outcome.value.steps.every((step) => step.ok && step.attempts === 1)).toBe(true);
      expect(requests).toEqual(expected);
      expect(sink.events.at(-1)).toMatchObject({ op: "synthetic.journey", result: "success", payload: { journey, status: "healthy" } });
    });

    it("delegates operation-history to the unchanged #269 monitor", async () => {
      const { fetchImpl, requests } = horizon({
        ...healthy(),
        [`/accounts/${ACCOUNT}/operations`]: [{ body: { _embedded: { records: [{ paging_token: "5", source_account: ACCOUNT }] } } }]
      });
      const outcome = await runJourney(SERVICE, "operation-history", options(fetchImpl).options);

      expect(outcome.ok && outcome.value).toMatchObject({ journey: "operation-history", status: "healthy" });
      expect(requests).toEqual(["/", "/operations?order=desc&limit=1", `/accounts/${ACCOUNT}/operations?order=desc&limit=20`]);
    });
  });

  describe("retry path", () => {
    it("retries a transient failure and reports degraded", async () => {
      const routes = healthy();
      routes["/fee_stats"] = [{ status: 503 }, "transport", { body: feeStats() }];
      const { fetchImpl } = horizon(routes);
      const { options: run, sleeps } = options(fetchImpl);

      const outcome = await runJourney(SERVICE, "fee-stats", run);
      expect(outcome.ok && outcome.value.status).toBe("degraded");
      expect(outcome.ok && outcome.value.steps[1]).toMatchObject({ step: "fee_stats.load", ok: true, attempts: 3 });
      expect(sleeps).toEqual([500, 1_000]);
    });

    it("honours Retry-After on a 429, capped at maxDelayMs", async () => {
      const routes = healthy();
      routes["/transactions"] = [{ status: 429, headers: { "retry-after": "99999" } }, routes["/transactions"][0]];
      const { fetchImpl } = horizon(routes);
      const { options: run, sleeps } = options(fetchImpl);

      await runJourney(SERVICE, "transaction-lookup", run);
      expect(sleeps).toEqual([10_000]);
    });
  });

  describe("failure path", () => {
    it.each([
      ["account-balances", `/accounts/${ACCOUNT}`, { body: { id: ACCOUNT, sequence: "1", balances: [{ balance: "1.5", asset_type: "credit_alphanum4" }] } }, "account.load"],
      ["account-balances", `/accounts/${ACCOUNT}`, { body: { id: ACCOUNT, sequence: "1", balances: [{ balance: 1.5, asset_type: "native" }] } }, "account.load"],
      ["account-balances", `/accounts/${ACCOUNT}`, { body: { id: `G${"C".repeat(55)}`, sequence: "1", balances: [{ balance: "1.0000000", asset_type: "native" }] } }, "account.load"],
      ["transaction-lookup", "/transactions", { body: { _embedded: { records: [{ hash: "XYZ" }] } } }, "transactions.discover"],
      ["transaction-lookup", `/transactions/${HASH}`, { body: { hash: "b".repeat(64), successful: true, ledger: 1 } }, "transaction.load"],
      ["fee-stats", "/fee_stats", { body: feeStats({ ledger_capacity_usage: "1.5" }) }, "fee_stats.load"],
      ["fee-stats", "/fee_stats", { body: feeStats({ last_ledger: 900 }) }, "fee_stats.load"]
    ] as const)("%s flags a malformed %s response", async (journey, path, reply, failedStep) => {
      const { fetchImpl } = horizon({ ...healthy(), [path]: [reply] });
      const outcome = await runJourney(SERVICE, journey, options(fetchImpl).options);

      expect(outcome.ok && outcome.value.status).toBe("unhealthy");
      const failure = outcome.ok ? outcome.value.steps.find((step) => !step.ok && !step.skipped) : undefined;
      expect(failure).toMatchObject({ step: failedStep, errorCode: "malformed_payload", attempts: 1 });
    });

    it("stops at a wrong network and lists the rest of the journey as skipped", async () => {
      const routes = healthy();
      routes["/"] = [{ body: { ...root(), network_passphrase: NETWORK_PASSPHRASES.mainnet } }];
      const { fetchImpl, requests } = horizon(routes);

      const outcome = await runJourney(SERVICE, "transaction-lookup", options(fetchImpl).options);
      expect(outcome.ok && outcome.value.steps).toEqual([
        expect.objectContaining({ step: "horizon.root", errorCode: "network_mismatch" }),
        expect.objectContaining({ step: "transactions.discover", skipped: true, attempts: 0 }),
        expect.objectContaining({ step: "transaction.load", skipped: true, attempts: 0 })
      ]);
      expect(requests).toEqual(["/"]);
    });

    it("reports no_activity for an empty network", async () => {
      const { fetchImpl } = horizon({ ...healthy(), "/transactions": [{ body: { _embedded: { records: [] } } }] });
      const outcome = await runJourney(SERVICE, "transaction-lookup", options(fetchImpl).options);
      expect(outcome.ok && outcome.value.steps[1]).toMatchObject({ errorCode: "no_activity" });
    });

    it("reports unhealthy once retries are exhausted", async () => {
      const { fetchImpl, requests } = horizon({ ...healthy(), "/fee_stats": [{ status: 500 }] });
      const outcome = await runJourney(SERVICE, "fee-stats", options(fetchImpl).options);
      expect(outcome.ok && outcome.value).toMatchObject({ status: "unhealthy", steps: [{ ok: true }, { errorCode: "server_error", attempts: 3 }] });
      expect(requests.filter((path) => path === "/fee_stats")).toHaveLength(3);
    });
  });

  describe("authorization path", () => {
    it("refuses a viewer before any request and records the refusal", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { fetchImpl, requests } = horizon(healthy());

      for (const journey of JOURNEY_IDS) {
        expect(await runJourney({ role: "viewer" }, journey, options(fetchImpl).options)).toEqual({ ok: false, code: "synthetic_unauthorized" });
      }
      expect(requests).toHaveLength(0);
      expect(sink.events.at(-1)).toMatchObject({ op: "synthetic.journey", errorCode: "synthetic_unauthorized", payload: { journey: "fee-stats" } });
    });

    it("refuses an unknown journey id", async () => {
      const { fetchImpl } = horizon(healthy());
      expect(await runJourney(SERVICE, "admin-panel" as never, options(fetchImpl).options)).toEqual({ ok: false, code: "unknown_journey" });
    });
  });

  describe("validators", () => {
    it("accept exact amounts and reject floats, negatives and missing XLM", () => {
      const account = (balances: unknown[]) => ({ id: ACCOUNT, sequence: "1", balances });
      expect(validateAccount(account([{ balance: "0.0000000", asset_type: "native" }]), ACCOUNT).ok).toBe(true);
      expect(validateAccount(account([{ balance: "-1.0000000", asset_type: "native" }]), ACCOUNT).ok).toBe(false);
      expect(validateAccount(account([{ balance: "1.00000001", asset_type: "native" }]), ACCOUNT).ok).toBe(false);
      expect(validateAccount(account([]), ACCOUNT).ok).toBe(false);
    });

    it("require fee percentiles that never decrease", () => {
      const charged = { ...feeStats().fee_charged, p95: "50" };
      expect(validateFeeStats(feeStats({ fee_charged: charged })).ok).toBe(false);
      expect(validateFeeStats(feeStats({ ledger_capacity_usage: "NaN" })).ok).toBe(false);
      expect(validateFeeStats(feeStats())).toEqual({ ok: true, value: { p50: 100n } });
    });
  });
});
