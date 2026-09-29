import { xdr } from "@stellar/stellar-sdk";
import type {
  SorobanSpecViewerErrorCode,
  SorobanSpecViewerInput,
  SorobanContractSpec,
  ScSpecFunction,
  ScSpecUdt,
  ScSpecError,
} from "@/features/soroban-spec-viewer/types";

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

function scSpecTypeToString(type: xdr.ScSpecUdtStructFieldV0 | any): string {
  try {
    if (!type) return "unknown";
    const arm = type.switch?.()?.name || type.type?.name || type.switch()?.name;
    switch (arm) {
      case "scSpecVal":
        return "Val";
      case "scSpecBool":
        return "Bool";
      case "scSpecVoid":
        return "Void";
      case "scSpecI32":
        return "I32";
      case "scSpecU32":
        return "U32";
      case "scSpecI64":
        return "I64";
      case "scSpecU64":
        return "U64";
      case "scSpecString":
        return "String";
      case "scSpecSymbol":
        return "Symbol";
      case "scSpecBytes":
        return "Bytes";
      case "scSpecAddress":
        return "Address";
      case "scSpecVec":
        return "Vec";
      case "scSpecMap":
        return "Map";
      case "scSpecUdt":
        return "Udt";
      default:
        return arm || "unknown";
    }
  } catch {
    return "unknown";
  }
}

function extractFunctions(specs: xdr.ScSpecEntry[]): ScSpecFunction[] {
  const functions: ScSpecFunction[] = [];

  for (const spec of specs) {
    if (spec.switch().name === "scSpecEntryFunctionV0") {
      const fnSpec = spec.functionV0();
      if (fnSpec) {
        const args = [];
        const fnArgs = fnSpec.inputs();
        if (fnArgs) {
          for (const arg of fnArgs) {
            args.push({
              name: arg.name().toString(),
              type: scSpecTypeToString(arg.type()),
            });
          }
        }

        functions.push({
          name: fnSpec.name().toString(),
          doc: fnSpec.doc()?.toString(),
          args,
          returns: scSpecTypeToString(fnSpec.outputs()?.[0]),
        });
      }
    }
  }

  return functions;
}

function extractTypes(specs: xdr.ScSpecEntry[]): ScSpecUdt[] {
  const types: ScSpecUdt[] = [];

  for (const spec of specs) {
    if (spec.switch().name === "scSpecEntryUdtStructV0") {
      const udtSpec = spec.udtStructV0();
      if (udtSpec) {
        const fields = [];
        const structFields = udtSpec.fields();
        if (structFields) {
          for (const field of structFields) {
            fields.push({
              name: field.name().toString(),
              type: scSpecTypeToString(field.type()),
            });
          }
        }

        types.push({
          name: udtSpec.name().toString(),
          doc: udtSpec.doc()?.toString(),
          fields,
        });
      }
    } else if (spec.switch().name === "scSpecEntryUdtEnumV0") {
      const enumSpec = spec.udtEnumV0();
      if (enumSpec) {
        const fields = [];
        const cases = enumSpec.cases();
        if (cases) {
          for (const c of cases) {
            fields.push({
              name: c.name().toString(),
              type: "variant",
            });
          }
        }

        types.push({
          name: enumSpec.name().toString(),
          doc: enumSpec.doc()?.toString(),
          fields,
        });
      }
    }
  }

  return types;
}

function extractErrors(specs: xdr.ScSpecEntry[]): ScSpecError[] {
  const errors: ScSpecError[] = [];

  for (const spec of specs) {
    if (spec.switch().name === "scSpecEntryErrorV0") {
      const errSpec = spec.errorV0();
      if (errSpec) {
        errors.push({
          name: errSpec.name().toString(),
          doc: errSpec.doc()?.toString(),
          code: errSpec.code() ?? 0,
        });
      }
    }
  }

  return errors;
}

function extractSpecFromWasm(wasmBytes: Buffer): ScSpecEntry[] {
  const specs: xdr.ScSpecEntry[] = [];

  try {
    // Look for custom section with spec data
    // WASM custom sections start with 0x00 followed by name length and name
    const customSectionName = Buffer.from([0x00, 0x07]); // 7 bytes for "contractspecv0"
    const name = "contractspecv0";
    const nameBuffer = Buffer.from(name);

    let offset = 0;
    while (offset < wasmBytes.length - 8) {
      if (
        wasmBytes[offset] === 0x00 &&
        wasmBytes.subarray(offset + 2, offset + 2 + name.length).toString() === name
      ) {
        // Found custom section
        const sectionStart = offset + 2 + name.length;
        const sectionLength = wasmBytes.readUInt32LE(offset + 1);
        const sectionData = wasmBytes.subarray(sectionStart, sectionStart + sectionLength - name.length - 1);

        // Parse spec entries from section data
        const decoded = xdr.ScSpec.fromXDR(sectionData);
        if (decoded && decoded.switch().name === "scSpecV0") {
          const v0 = decoded.v0();
          if (v0) {
            return v0;
          }
        }

        break;
      }
      offset++;
    }
  } catch {
    // Continue without specs
  }

  return specs;
}

export function validateContractAddress(address: string): Result<string, SorobanSpecViewerErrorCode> {
  const trimmed = address.trim();

  if (!trimmed) {
    return err("empty_input");
  }

  if (!trimmed.startsWith("C") || trimmed.length !== 56) {
    return err("invalid_address");
  }

  return ok(trimmed);
}

export async function fetchSorobanContractSpec(
  input: SorobanSpecViewerInput
): Promise<Result<SorobanContractSpec, SorobanSpecViewerErrorCode>> {
  const addressValidation = validateContractAddress(input.contractAddress);
  if (!addressValidation.ok) {
    return addressValidation;
  }

  try {
    const rpcUrl =
      input.network === "mainnet"
        ? "https://soroban-rpc.stellar.org"
        : "https://soroban-rpc.testnet.stellar.org";

    // Fetch contract instance
    const contractKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contractId: xdr.ContractId.contractIdFromSourceAccount(
          xdr.PublicKey.publicKeyTypeEd25519(xdr.Uint256.fromXDR(Buffer.alloc(32))),
          0
        ),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvSymbol(Buffer.from("Metadata")),
      })
    );

    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: {
        keys: [contractKey.toXDR("base64")],
      },
    };

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcRequest),
    });

    if (!response.ok) {
      return err("network_error");
    }

    const result = await response.json();

    if (result.error) {
      return err("rpc_error");
    }

    if (!result.result?.entries || result.result.entries.length === 0) {
      return err("contract_not_found");
    }

    // For now, return a placeholder spec
    // In production, this would parse the WASM and extract specs
    return ok({
      contractId: input.contractAddress,
      wasmHash: "placeholder",
      functions: [],
      types: [],
      errors: [],
    });
  } catch {
    return err("network_error");
  }
}

export type { ScSpecEntry };
interface ScSpecEntry {}
