import { xdr } from "@stellar/stellar-sdk";
import type {
  SorobanFeeEstimatorErrorCode,
  SorobanFeeEstimatorInput,
  SorobanResourceFeeEstimate,
} from "@/features/soroban-fee-estimator/types";

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

interface FeeStats {
  cpuInstructionPrice: string;
  memoryBytePrice: string;
  ledgerReadBytePrice: string;
  ledgerWriteBytePrice: string;
  ledgerRentFeePrice: string;
  rentExpenseWindow: string;
}

interface ResourceCount {
  cpuInstructions: bigint;
  memoryBytes: bigint;
  ledgerReadBytes: bigint;
  ledgerWriteBytes: bigint;
  ledgerRentBytes: bigint;
}

function multiplyBigInts(a: bigint, b: bigint): bigint {
  return a * b;
}

function extractSorobanResources(tx: xdr.Transaction): Result<ResourceCount, SorobanFeeEstimatorErrorCode> {
  const operations = tx.operations();
  if (!operations) {
    return err("no_resources");
  }

  let hasSoroban = false;
  let resources: ResourceCount = {
    cpuInstructions: 0n,
    memoryBytes: 0n,
    ledgerReadBytes: 0n,
    ledgerWriteBytes: 0n,
    ledgerRentBytes: 0n,
  };

  for (const op of operations) {
    if (op.body().switch().name === "invokeHostFunction") {
      hasSoroban = true;
      const hostFn = op.body().invokeHostFunctionOp();
      if (hostFn) {
        const sorobanResources = hostFn.hostFunction().invokeContractArgs()?.resources();
        if (sorobanResources) {
          const footprint = sorobanResources.footprint();
          if (footprint) {
            resources.ledgerReadBytes = BigInt(footprint.readOnly()?.length ?? 0) * 36n;
            resources.ledgerWriteBytes = BigInt(footprint.readWrite()?.length ?? 0) * 36n;
          }

          const cpuIns = sorobanResources.cpuInstructions();
          if (cpuIns) {
            resources.cpuInstructions = BigInt(cpuIns);
          }

          const memBytes = sorobanResources.memBytes();
          if (memBytes) {
            resources.memoryBytes = BigInt(memBytes);
          }
        }
      }
    }
  }

  if (!hasSoroban) {
    return err("not_soroban");
  }

  if (Object.values(resources).every((v) => v === 0n)) {
    return err("no_resources");
  }

  return ok(resources);
}

function computeFeeComponents(
  resources: ResourceCount,
  pricing: FeeStats
): {
  totalFee: bigint;
  cpuFee: bigint;
  memFee: bigint;
  readFee: bigint;
  writeFee: bigint;
  rentFee: bigint;
} {
  const cpuPrice = BigInt(pricing.cpuInstructionPrice);
  const memPrice = BigInt(pricing.memoryBytePrice);
  const readPrice = BigInt(pricing.ledgerReadBytePrice);
  const writePrice = BigInt(pricing.ledgerWriteBytePrice);
  const rentPrice = BigInt(pricing.ledgerRentFeePrice);

  const cpuFee = multiplyBigInts(resources.cpuInstructions, cpuPrice);
  const memFee = multiplyBigInts(resources.memoryBytes, memPrice);
  const readFee = multiplyBigInts(resources.ledgerReadBytes, readPrice);
  const writeFee = multiplyBigInts(resources.ledgerWriteBytes, writePrice);
  const rentFee = multiplyBigInts(resources.ledgerRentBytes, rentPrice);

  const totalFee = cpuFee + memFee + readFee + writeFee + rentFee;

  return { totalFee, cpuFee, memFee, readFee, writeFee, rentFee };
}

export function parseInput(
  input: string
): Result<SorobanFeeEstimatorInput, SorobanFeeEstimatorErrorCode> {
  const trimmed = input.trim();

  if (!trimmed) {
    return err("empty_input");
  }

  try {
    Buffer.from(trimmed, "base64");
  } catch {
    return err("invalid_base64");
  }

  return ok({
    envelope: trimmed,
    network: "mainnet",
  });
}

export async function fetchFeeStats(
  network: "mainnet" | "testnet"
): Promise<Result<FeeStats, SorobanFeeEstimatorErrorCode>> {
  try {
    const rpcUrl =
      network === "mainnet"
        ? "https://soroban-rpc.stellar.org"
        : "https://soroban-rpc.testnet.stellar.org";

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getFeeStats",
      }),
    });

    if (!response.ok) {
      return err("request_failed");
    }

    const result = await response.json();

    if (result.error) {
      return err("rpc_error");
    }

    if (!result.result) {
      return err("pricing_unavailable");
    }

    const stats = result.result;
    return ok({
      cpuInstructionPrice: stats.cpuInstructionPrice || "100",
      memoryBytePrice: stats.memoryBytePrice || "500",
      ledgerReadBytePrice: stats.ledgerReadBytePrice || "10000",
      ledgerWriteBytePrice: stats.ledgerWriteBytePrice || "10000",
      ledgerRentFeePrice: stats.ledgerRentFeePrice || "10",
      rentExpenseWindow: stats.rentExpenseWindow || "518400",
    });
  } catch {
    return err("request_failed");
  }
}

export function estimateFees(
  envelope: string,
  pricing: FeeStats
): Result<SorobanResourceFeeEstimate, SorobanFeeEstimatorErrorCode> {
  try {
    const txEnvelope = xdr.TransactionEnvelope.fromXDR(envelope, "base64");

    let tx: xdr.Transaction;
    const envType = txEnvelope.switch().name;

    if (envType === "envelopeTypeTxV0") {
      const v0 = txEnvelope.v1Tx();
      if (!v0) return err("invalid_xdr");
      tx = v0.tx();
    } else if (envType === "envelopeTypeTx") {
      const v1 = txEnvelope.v1Tx();
      if (!v1) return err("invalid_xdr");
      tx = v1.tx();
    } else if (envType === "envelopeTypeFeeBumpTx") {
      const feeBump = txEnvelope.feeBumpTx();
      if (!feeBump) return err("invalid_xdr");
      tx = feeBump.tx().innerTx().v1Tx().tx();
    } else {
      return err("invalid_xdr");
    }

    const resourcesResult = extractSorobanResources(tx);
    if (!resourcesResult.ok) {
      return resourcesResult;
    }

    const fees = computeFeeComponents(resourcesResult.value, pricing);
    const declaredFee = BigInt(tx.fee() || 0);

    const difference = declaredFee - fees.totalFee;
    const status = difference >= 0n ? "sufficient" : "insufficient";

    return ok({
      declaredFee: declaredFee.toString(),
      estimatedFee: fees.totalFee.toString(),
      difference: Math.abs(Number(difference)).toString(),
      status,
      components: {
        cpuInstructions: {
          name: "CPU Instructions",
          resourceCount: resourcesResult.value.cpuInstructions.toString(),
          unitPrice: pricing.cpuInstructionPrice,
          totalFee: fees.cpuFee.toString(),
        },
        memoryBytes: {
          name: "Memory Bytes",
          resourceCount: resourcesResult.value.memoryBytes.toString(),
          unitPrice: pricing.memoryBytePrice,
          totalFee: fees.memFee.toString(),
        },
        ledgerReadBytes: {
          name: "Ledger Read Bytes",
          resourceCount: resourcesResult.value.ledgerReadBytes.toString(),
          unitPrice: pricing.ledgerReadBytePrice,
          totalFee: fees.readFee.toString(),
        },
        ledgerWriteBytes: {
          name: "Ledger Write Bytes",
          resourceCount: resourcesResult.value.ledgerWriteBytes.toString(),
          unitPrice: pricing.ledgerWriteBytePrice,
          totalFee: fees.writeFee.toString(),
        },
        ledgerRentBytes: {
          name: "Ledger Rent Bytes",
          resourceCount: resourcesResult.value.ledgerRentBytes.toString(),
          unitPrice: pricing.ledgerRentFeePrice,
          totalFee: fees.rentFee.toString(),
        },
      },
    });
  } catch {
    return err("invalid_xdr");
  }
}
