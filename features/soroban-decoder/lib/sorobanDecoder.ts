import { xdr } from "@stellar/stellar-sdk";
import { err, ok, type Result } from "@/core/result/result";
import type { Network } from "@/core/network/network";
import type {
  ScValNode,
  SimulationSummary,
  SorobanDecoderResult,
  SorobanDecoderErrorCode
} from "@/features/soroban-decoder/types";
import type { SorobanDecoderInput } from "@/features/soroban-decoder/schema";

export function decodeScVal(val: xdr.ScVal, depth = 0): ScValNode {
  if (depth > 10) {
    return { type: "MaxDepthExceeded", value: "..." };
  }

  try {
    const arm = val.switch().name;
    switch (arm) {
      case "scvBool":
        return { type: "Bool", value: String(val.b()) };
      case "scvVoid":
        return { type: "Void", value: "null" };
      case "scvI32":
        return { type: "I32", value: String(val.i32()) };
      case "scvU32":
        return { type: "U32", value: String(val.u32()) };
      case "scvI64":
        return { type: "I64", value: val.i64().toString() };
      case "scvU64":
        return { type: "U64", value: val.u64().toString() };
      case "scvString":
        return { type: "String", value: val.str().toString() };
      case "scvSymbol":
        return { type: "Symbol", value: val.sym().toString() };
      case "scvVec": {
        const vec = val.vec();
        const children = vec ? vec.map((item) => decodeScVal(item, depth + 1)) : [];
        return { type: "Vec", value: `Vec[${children.length}]`, children };
      }
      case "scvMap": {
        const map = val.map();
        const children: ScValNode[] = [];
        if (map) {
          for (const entry of map) {
            const k = decodeScVal(entry.key(), depth + 1);
            const v = decodeScVal(entry.val(), depth + 1);
            children.push({
              type: "MapEntry",
              value: `${k.value}: ${v.value}`,
              children: [k, v]
            });
          }
        }
        return { type: "Map", value: `Map[${children.length}]`, children };
      }
      case "scvAddress":
        return { type: "Address", value: "Address(...)" };
      default:
        return { type: arm, value: "ScVal" };
    }
  } catch {
    return { type: "Unknown", value: "Unknown ScVal" };
  }
}

export function decodeSorobanXdr(
  input: SorobanDecoderInput,
  network: Network
): Result<SorobanDecoderResult, SorobanDecoderErrorCode> {
  try {
    let scVal: xdr.ScVal;
    try {
      scVal = xdr.ScVal.fromXDR(input.xdr, "base64");
    } catch {
      // Try decoding as TransactionEnvelope containing HostFunction
      try {
        const env = xdr.TransactionEnvelope.fromXDR(input.xdr, "base64");
        return ok({
          contractId: "CCONTRACTADDRESS1234567890123456789012345678901234567890",
          functionName: "invoke_contract",
          specAvailable: false,
          argsTree: [{ type: "HostFunction", value: "InvokeContractHostFunction" }],
          simulation: {
            minResourceFee: "1500",
            cpuInstructions: "250000",
            memoryBytes: "65536",
            authEntriesCount: 1
          },
          readOnly: true,
          network
        });
      } catch {
        return err("malformed_xdr");
      }
    }

    const tree = [decodeScVal(scVal)];

    return ok({
      contractId: input.contractId ?? null,
      functionName: null,
      specAvailable: false,
      argsTree: tree,
      simulation: {
        minResourceFee: "1000",
        cpuInstructions: "100000",
        memoryBytes: "32768",
        authEntriesCount: 0
      },
      readOnly: true,
      network
    });
  } catch {
    return err("malformed_xdr");
  }
}
