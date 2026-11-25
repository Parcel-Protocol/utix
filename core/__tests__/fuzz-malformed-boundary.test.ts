/**
 * Extended fuzz tests for malformed and boundary inputs (#453)
 *
 * Extends the existing fuzz suite in `core/__tests__/fuzz.test.ts` with
 * additional property-based coverage for:
 *   - `horizonToProblemDetails` / `rpcToProblemDetails` with arbitrary input
 *   - `getProblemDefinition` and `problemDetailsFromCode` with every code
 *   - `PermissionDiffEngine.generateDiffReport` with boundary role/permission inputs
 *   - `verifyReleaseRollback` with adversarial dataset shapes
 *
 * Every property states what must hold for every input — never throw, always
 * return a declared shape.  A failure reproduces exactly with:
 *   FUZZ_SEED=<seed> npm test -- core/__tests__/fuzz-malformed-boundary
 *
 * Run individually:
 *   npm test -- core/__tests__/fuzz-malformed-boundary
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  getProblemDefinition,
  PROBLEM_CODES,
  problemDetailsFromCode,
  rpcToProblemDetails,
  horizonToProblemDetails,
  isProblemRetryable,
  type ProblemCode,
} from "@/core/errors/problem-details";
import {
  AMOUNT_DECIMALS,
  amountToStroops,
  INT64_MAX,
  INT64_MIN,
  parseAmount,
  stroopsToAmount,
  type AmountParseError,
} from "@/core/format/amount";
import {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from "@/core/auth/types";
import { PermissionDiffEngine } from "@/core/policy/permissionDiff";
import {
  verifyReleaseRollback,
  type ProtocolDataset,
  type RollbackTarget,
} from "@/core/recovery/rollback-verifier";
import { classifyRpcError, classifyRpcTransportError } from "@/core/rpc/errors";
import { classifyHorizonError } from "@/core/horizon/errors";
import { RPC_STANDARD_CODES } from "@/core/rpc/client";
import { parseJsonRpcResponse } from "@/core/rpc/client";

// ─── PRNG (identical to fuzz.test.ts so seed semantics are consistent) ────────

const SEED = Number(process.env.FUZZ_SEED ?? 0x5eed_0453);
const RUNS = 500;

function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const str = (alphabet: string, maxLen: number) =>
    Array.from({ length: int(maxLen + 1) }, () => alphabet[int(alphabet.length)]).join("");
  const int64 = () => {
    const high = BigInt(int(2 ** 32)) << 32n;
    return BigInt.asIntN(64, high | BigInt(int(2 ** 32)));
  };
  return { next, int, pick, str, int64 };
}

const BOUNDARY_AMOUNTS = [
  "0",
  "0.0000001",
  "0.00000001",           // too_many_decimals
  "-0.0000001",           // negative
  "922337203685.4775807", // INT64_MAX
  "922337203685.4775808", // out_of_range
  "-922337203685.4775808",// INT64_MIN
  "-922337203685.4775809",// out_of_range
  "",                     // empty
  "   ",
  "1.",
  ".1",
  "1.2.3",
  "1,000",
  "1e7",
  "NaN",
  "Infinity",
  "-Infinity",
  "9".repeat(30),
  "0." + "0".repeat(8) + "1",
];

const AMOUNT_ERRORS: readonly AmountParseError[] = [
  "empty",
  "grouping_separator",
  "invalid_format",
  "too_many_decimals",
  "negative",
  "out_of_range",
];

// ─── Amount boundary fuzz ─────────────────────────────────────────────────────

describe("#453 — fuzz: amount boundaries and malformed strings", () => {
  it("boundary corpus: each known boundary produces either a valid BigInt or a declared error", () => {
    for (const raw of BOUNDARY_AMOUNTS) {
      const parsed = parseAmount(raw, { allowNegative: true });
      if (parsed.ok) {
        expect(parsed.value <= INT64_MAX && parsed.value >= INT64_MIN, `out of range: ${raw}`).toBe(true);
      } else {
        expect(AMOUNT_ERRORS, `undeclared error for: ${raw}`).toContain(parsed.code);
      }
    }
  });

  it("random fuzz: malformed amount strings never throw and always return a declared code", () => {
    const random = prng(SEED);
    for (let run = 0; run < RUNS; run++) {
      const raw = random.str("0123456789.,+-eE _'٣\t\n\r", 24);
      let result: ReturnType<typeof parseAmount>;
      expect(() => {
        result = parseAmount(raw, { allowNegative: random.next() < 0.5 });
      }, `seed ${SEED}, run ${run}: ${JSON.stringify(raw)}`).not.toThrow();
      result = parseAmount(raw, { allowNegative: true });
      if (result.ok) {
        expect(result.value <= INT64_MAX && result.value >= INT64_MIN).toBe(true);
      } else {
        expect(AMOUNT_ERRORS).toContain(result.code);
      }
    }
  });

  it("every random int64 stroop round-trips through stroopsToAmount → parseAmount", () => {
    const random = prng(SEED + 1);
    const samples = [
      INT64_MAX, INT64_MIN, 0n, 1n, -1n, 10_000_000n, -10_000_000n,
      ...Array.from({ length: RUNS }, random.int64),
    ];
    for (const stroops of samples) {
      const amount = stroopsToAmount(stroops);
      expect(amount, `seed ${SEED + 1}: stroops ${stroops}`).toMatch(
        new RegExp(`^-?\\d+\\.\\d{${AMOUNT_DECIMALS}}$`)
      );
      const parsed = parseAmount(amount, { allowNegative: true });
      expect(parsed, `round-trip failed for stroops ${stroops}`).toEqual({ ok: true, value: stroops });
      expect(amountToStroops(amount)).toBe(stroops);
    }
  });
});

// ─── JSON-RPC malformed payload fuzz ────────────────────────────────────────

describe("#453 — fuzz: malformed JSON-RPC payloads", () => {
  const JUNK_PAYLOADS: unknown[] = [
    null,
    undefined,
    0,
    "",
    [],
    [1, 2, 3],
    true,
    false,
    Symbol("sym"),
    BigInt(42),
    { jsonrpc: null },
    { jsonrpc: "1.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32600, message: "x" } }, // both result and error
    { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: NaN, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: Infinity, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: "-32600", message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: null, message: "x" } },
  ];

  it("boundary corpus: each malformed payload never throws and returns a valid envelope", () => {
    for (const payload of JUNK_PAYLOADS) {
      let parsed: ReturnType<typeof parseJsonRpcResponse<unknown>>;
      expect(() => {
        parsed = parseJsonRpcResponse(payload, 1);
      }).not.toThrow();
      parsed = parseJsonRpcResponse(payload, 1);
      expect(parsed.jsonrpc).toBe("2.0");
      expect("result" in parsed !== "error" in parsed).toBe(true);
      if ("error" in parsed) {
        expect(Number.isInteger(parsed.error.code)).toBe(true);
        expect(typeof parsed.error.message).toBe("string");
      }
    }
  });

  it("random fuzz: arbitrary values never throw and always produce a well-formed envelope", () => {
    const random = prng(SEED + 2);
    function arb(depth = 0): unknown {
      if (depth >= 3 || random.next() < 0.4) {
        return random.pick([null, undefined, 0, "", true, BigInt(1), Symbol("s"), NaN, Infinity]);
      }
      if (random.next() < 0.3) {
        return Array.from({ length: random.int(4) }, () => arb(depth + 1));
      }
      const obj: Record<string, unknown> = {};
      for (let i = random.int(5); i > 0; i--) {
        const key = random.pick(["jsonrpc", "id", "result", "error", "code", "message", "__proto__"]);
        obj[key] = arb(depth + 1);
      }
      if (random.next() < 0.1) obj.self = obj;
      return obj;
    }

    for (let run = 0; run < RUNS; run++) {
      const payload = arb();
      let parsed: ReturnType<typeof parseJsonRpcResponse<unknown>>;
      expect(() => {
        parsed = parseJsonRpcResponse(payload, undefined);
      }, `seed ${SEED + 2}, run ${run}`).not.toThrow();
      parsed = parseJsonRpcResponse(payload, undefined);
      expect(parsed.jsonrpc, `run ${run}`).toBe("2.0");
      expect("result" in parsed !== "error" in parsed, `run ${run}`).toBe(true);
      if ("error" in parsed) {
        expect(Number.isInteger(parsed.error.code), `run ${run}`).toBe(true);
      }
    }
  });
});

// ─── Problem-details boundary fuzz ──────────────────────────────────────────

describe("#453 — fuzz: problem-details with boundary inputs", () => {
  const ALL_CODES = Object.keys(PROBLEM_CODES) as ProblemCode[];

  it("every code produces a well-formed envelope: never throws", () => {
    for (const code of ALL_CODES) {
      expect(() => problemDetailsFromCode(code)).not.toThrow();
    }
  });

  it("correlationId with boundary strings never throws", () => {
    const random = prng(SEED + 3);
    const BOUNDARY_IDS = [
      "",
      " ",
      "\x00",
      "a".repeat(256),
      "<script>alert(1)</script>",
      "'; DROP TABLE problems; --",
      random.str("αβγδ🚀\0\t\n", 50),
    ];

    for (const id of BOUNDARY_IDS) {
      expect(() =>
        problemDetailsFromCode("account_not_found", { correlationId: id })
      ).not.toThrow();
    }
  });

  it("overrideDetail with boundary strings is propagated without throwing", () => {
    const BOUNDARY_DETAILS = [
      "",
      " ".repeat(5000),
      "\x00\x01\x02",
      "<img src=x onerror=alert(1)>",
      "a".repeat(10_000),
    ];

    for (const detail of BOUNDARY_DETAILS) {
      const pd = problemDetailsFromCode("validation_error", { overrideDetail: detail });
      expect(pd.detail).toBe(detail);
    }
  });

  it("extensions with boundary values never throws", () => {
    const BOUNDARY_EXTENSIONS: Record<string, unknown>[] = [
      {},
      { a: null },
      { a: undefined },
      { a: NaN },
      { a: Infinity },
      { [Symbol.toString()]: "sym" },
      { longKey: "x".repeat(10_000) },
    ];

    for (const ext of BOUNDARY_EXTENSIONS) {
      expect(() =>
        problemDetailsFromCode("internal_error", { extensions: ext })
      ).not.toThrow();
    }
  });

  it("random fuzz: horizonToProblemDetails never throws for any classification", () => {
    const horizonCodes = ["not_found", "rate_limited", "bad_request", "server_error", "network_unavailable", "timeout", "unknown"] as const;
    const random = prng(SEED + 4);

    for (let run = 0; run < RUNS; run++) {
      const code = random.pick(horizonCodes);
      const corr = random.next() < 0.3 ? random.str("abcdef0123456789-", 36) : undefined;
      const classified = classifyHorizonError({ status: 500, detail: "err", extras: {} }, code, corr);
      expect(() => horizonToProblemDetails(classified)).not.toThrow();
      const pd = horizonToProblemDetails(classified);
      expect(pd.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(typeof pd.retryable).toBe("boolean");
    }
  });

  it("random fuzz: rpcToProblemDetails never throws for any transport error", () => {
    const transportTypes = ["timeout", "network_unavailable"] as const;
    const rpcCodes = [
      RPC_STANDARD_CODES.PARSE_ERROR,
      RPC_STANDARD_CODES.INVALID_REQUEST,
      RPC_STANDARD_CODES.METHOD_NOT_FOUND,
      RPC_STANDARD_CODES.INVALID_PARAMS,
      RPC_STANDARD_CODES.INTERNAL_ERROR,
    ];
    const random = prng(SEED + 5);

    for (let run = 0; run < RUNS; run++) {
      if (random.next() < 0.5) {
        const tType = random.pick(transportTypes);
        const classified = classifyRpcTransportError(tType);
        expect(() => rpcToProblemDetails(classified)).not.toThrow();
      } else {
        const code = random.pick(rpcCodes);
        const classified = classifyRpcError({ code, message: random.str("abcdef 0123", 20) });
        expect(() => rpcToProblemDetails(classified)).not.toThrow();
      }
    }
  });
});

// ─── Authorization boundary fuzz ────────────────────────────────────────────

describe("#453 — fuzz: authorization with malformed and boundary inputs", () => {
  const knownRoles = Object.keys(ROLE_PERMISSIONS);
  const allPermissions = Object.values(ROLE_PERMISSIONS).flat() as Permission[];

  it("unknown roles are denied for every permission — never throws", () => {
    const random = prng(SEED + 6);
    const unknownRoles = [
      "admin", "VIEWER", "", " viewer", "toString", "__proto__", "constructor",
      undefined, null, 0, false, [],
      ...Array.from({ length: RUNS }, () => random.str("abcdefghijklmnopqrstuvwxyz_ ", 12)),
    ].filter((r) => !knownRoles.includes(r as string)) as unknown as Role[];

    for (const role of unknownRoles) {
      for (const perm of allPermissions) {
        expect(() => hasPermission(role, perm)).not.toThrow();
        expect(hasPermission(role, perm), `${String(role)} must be denied`).toBe(false);
      }
      expect(() => hasAnyPermission(role, allPermissions)).not.toThrow();
      expect(hasAnyPermission(role, allPermissions)).toBe(false);
      expect(() => hasAllPermissions(role, allPermissions)).not.toThrow();
      expect(hasAllPermissions(role, allPermissions)).toBe(false);
    }
  });

  it("known roles retain their exact declared grants — fuzz cannot change them", () => {
    for (const role of knownRoles as Role[]) {
      for (const perm of allPermissions) {
        expect(hasPermission(role, perm)).toBe(ROLE_PERMISSIONS[role].includes(perm));
      }
    }
  });

  it("PermissionDiffEngine.generateDiffReport never throws for boundary proposed inputs", () => {
    const BASE = {
      viewer: ["view:tools", "view:dashboard"] as Permission[],
      maintainer: ["view:tools", "view:dashboard", "admin:health", "admin:recovery", "admin:metrics", "admin:replay"] as Permission[],
      service: ["admin:health", "admin:metrics"] as Permission[],
    };
    const maintainerCtx = { role: "maintainer" as const, userId: "admin" };

    const boundaryProposed: Array<unknown> = [
      null,
      undefined,
      {},
      { viewer: null },
      { viewer: undefined },
      { viewer: "view:tools" },
      { viewer: ["view:tools"], super_admin: ["admin:recovery"] },
      { viewer: [], maintainer: [], service: [] },
    ];

    for (const proposed of boundaryProposed) {
      expect(() =>
        PermissionDiffEngine.generateDiffReport(
          BASE,
          proposed as never,
          { caller: maintainerCtx }
        )
      ).not.toThrow();
    }
  });
});

// ─── Rollback verifier boundary fuzz ───────────────────────────────────────

describe("#453 — fuzz: rollback verifier with adversarial dataset shapes", () => {
  const DEFAULT_TARGET: RollbackTarget = {
    targetVersion: "1.0.0",
    rolledBackFromVersion: "1.1.0",
    rollbackTimestamp: 1_700_000_000_000,
  };

  it("verifyReleaseRollback never throws for empty dataset", () => {
    expect(() =>
      verifyReleaseRollback(
        { events: [], tickets: [], transfers: [], redemptions: [], workerJobs: [], fraudRecords: [] },
        DEFAULT_TARGET
      )
    ).not.toThrow();
  });

  it("verifyReleaseRollback never throws for datasets with boundary Stellar addresses", () => {
    const BOUNDARY_KEYS = [
      "",
      "GABC",
      "X".repeat(56),
      "g" + "A".repeat(55), // wrong prefix
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x01)).publicKey(), // valid
    ];

    for (const owner of BOUNDARY_KEYS) {
      const dataset: ProtocolDataset = {
        events: [],
        tickets: [
          {
            id: `tkt-${owner.slice(0, 8)}`,
            eventId: "evt-x",
            owner,
            tier: "general",
            status: "issued",
            protocolVersion: "1.0.0",
            issuedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        transfers: [],
        redemptions: [],
        workerJobs: [],
        fraudRecords: [],
      };

      expect(() => verifyReleaseRollback(dataset, DEFAULT_TARGET)).not.toThrow();
    }
  });

  it("verifyReleaseRollback never throws for datasets with boundary transaction hashes", () => {
    const BOUNDARY_HASHES = [
      "",
      "not-hex",
      "DEADBEEF",
      "0".repeat(64),
      "0".repeat(63),  // one char short
      "0".repeat(65),  // one char too long
      "z".repeat(64),  // non-hex chars
      "0x" + "0".repeat(62),
    ];

    const validKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x07)).publicKey();

    for (const hash of BOUNDARY_HASHES) {
      const dataset: ProtocolDataset = {
        events: [],
        tickets: [
          {
            id: `tkt-${hash.slice(0, 6)}`,
            eventId: "evt-y",
            owner: validKey,
            tier: "general",
            status: "issued",
            protocolVersion: "1.0.0",
            externalRef: hash,
            issuedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        transfers: [],
        redemptions: [],
        workerJobs: [],
        fraudRecords: [],
      };

      expect(() => verifyReleaseRollback(dataset, DEFAULT_TARGET)).not.toThrow();
    }
  });

  it("verifyReleaseRollback always returns a report with the correct structure", () => {
    const random = prng(SEED + 7);
    const validKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x05)).publicKey();

    // Generate datasets of random sizes
    for (let run = 0; run < 50; run++) {
      const nTickets = random.int(10);
      const tickets = Array.from({ length: nTickets }, (_, i) => ({
        id: `tkt-${run}-${i}`,
        eventId: `evt-${run}`,
        owner: validKey,
        tier: "general",
        status: random.pick(["issued", "transferred", "redeemed", "cancelled"] as const),
        protocolVersion: random.next() < 0.3 ? "1.1.0" : "1.0.0",
        issuedAt: Date.now(),
        updatedAt: Date.now(),
      }));

      const dataset: ProtocolDataset = {
        events: random.next() < 0.5
          ? [{
              id: `evt-${run}`,
              name: "Fuzz Event",
              organizerAddress: validKey,
              capacity: random.int(20),
              status: "active",
              protocolVersion: "1.0.0",
              createdAt: Date.now(),
            }]
          : [],
        tickets,
        transfers: [],
        redemptions: [],
        workerJobs: [],
        fraudRecords: [],
      };

      let report: ReturnType<typeof verifyReleaseRollback>;
      expect(() => {
        report = verifyReleaseRollback(dataset, DEFAULT_TARGET);
      }, `seed ${SEED + 7}, run ${run}`).not.toThrow();

      report = verifyReleaseRollback(dataset, DEFAULT_TARGET);
      expect(typeof report.isClean).toBe("boolean");
      expect(typeof report.passed).toBe("boolean");
      expect(typeof report.requiresManualRepair).toBe("boolean");
      expect(report.totalChecks).toBe(6);
      expect(Array.isArray(report.checks)).toBe(true);
      expect(Array.isArray(report.manualRepairRecords)).toBe(true);
      expect(report.passedChecks + report.failedChecks).toBe(report.totalChecks);
    }
  });

  it("verifyReleaseRollback with large datasets does not degrade result correctness", () => {
    const validKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x09)).publicKey();
    const eventId = "evt-large";

    const tickets = Array.from({ length: 1_000 }, (_, i) => ({
      id: `tkt-${i}`,
      eventId,
      owner: validKey,
      tier: "general",
      status: "issued" as const,
      protocolVersion: "1.0.0",
      issuedAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const dataset: ProtocolDataset = {
      events: [{
        id: eventId,
        name: "Large Event",
        organizerAddress: validKey,
        capacity: 2_000, // comfortably above 1000
        status: "active",
        protocolVersion: "1.0.0",
        createdAt: Date.now(),
      }],
      tickets,
      transfers: [],
      redemptions: [],
      workerJobs: [],
      fraudRecords: [],
    };

    const report = verifyReleaseRollback(dataset, DEFAULT_TARGET);
    expect(report.isClean).toBe(true);
  });
});
