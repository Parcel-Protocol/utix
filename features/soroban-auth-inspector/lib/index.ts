import { xdr } from "@stellar/stellar-sdk";
import type {
  SorobanAuthInspectorErrorCode,
  SorobanAuthInspectorInput,
  SorobanAuthInspectorResult,
  SorobanInvocationNode,
  SorobanAuthorizationTreeNode,
  ScValNode,
  Credentials,
} from "@/features/soroban-auth-inspector/types";

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

function decodeScVal(val: xdr.ScVal, depth = 0): ScValNode {
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
        return { type: "String", value: String(val.str()) };
      case "scvSymbol":
        return { type: "Symbol", value: String(val.sym()) };
      case "scvVec": {
        const vec = val.vec();
        const children = vec
          ? vec.map((item) => decodeScVal(item, depth + 1))
          : [];
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
              children: [k, v],
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

function decodeInvocation(
  inv: xdr.SorobanInvokedAction,
): SorobanInvocationNode {
  const contractAddress = Buffer.from(
    inv.contractAddress().contractId(),
  ).toString("hex");
  const functionName = inv.functionName().toString();

  const args: ScValNode[] = [];
  const argsArray = inv.args();
  if (argsArray) {
    for (const arg of argsArray) {
      args.push(decodeScVal(arg));
    }
  }

  return {
    contractAddress,
    functionName,
    args,
    children: [],
  };
}

function extractCredentials(cred: xdr.SorobanCredentials): Credentials {
  const credType = cred.switch().name;

  if (credType === "sourceAccountCredential") {
    return { type: "source_account" };
  }

  if (credType === "soSignerCredential") {
    const signerCred = cred.soSignerCredential();
    const address = signerCred.address().accountId().toString("hex");
    const nonce = signerCred.nonce().toString();
    const expiryLedger = signerCred.expirationLedger() ?? 0;

    return {
      type: "address",
      address,
      nonce,
      expiryLedger,
    };
  }

  return { type: "source_account" };
}

function decodeSorobanAuthorizationEntry(
  entry: xdr.SorobanAuthorizationEntry,
): Result<SorobanAuthorizationTreeNode, SorobanAuthInspectorErrorCode> {
  try {
    const credentials = extractCredentials(entry.credentials());
    const rootInvocation = decodeInvocation(entry.rootInvocation());

    return ok({
      credentials,
      rootInvocation,
      impliesUnobviousSubInvocation: false,
    });
  } catch {
    return err("auth_unreadable");
  }
}

export function parseSorobanAuthInspectorInput(
  input: string,
): Result<SorobanAuthInspectorInput, SorobanAuthInspectorErrorCode> {
  const trimmed = input.trim();

  if (!trimmed) {
    return err("empty_input");
  }

  try {
    Buffer.from(trimmed, "base64");
  } catch {
    return err("invalid_base64");
  }

  return ok({ envelope: trimmed });
}

export function decodeSorobanAuthInspector(
  input: SorobanAuthInspectorInput,
): Result<SorobanAuthInspectorResult, SorobanAuthInspectorErrorCode> {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(input.envelope, "base64");

    let tx: xdr.Transaction;
    const envType = envelope.switch().name;

    if (envType === "envelopeTypeTxV0") {
      const v0 = envelope.v1Tx();
      if (!v0) return err("invalid_xdr");
      tx = v0.tx();
    } else if (envType === "envelopeTypeTx") {
      const v1 = envelope.v1Tx();
      if (!v1) return err("invalid_xdr");
      tx = v1.tx();
    } else if (envType === "envelopeTypeFeeBumpTx") {
      const feeBump = envelope.feeBumpTx();
      if (!feeBump) return err("invalid_xdr");
      tx = feeBump.tx().innerTx().v1Tx().tx();
    } else {
      return err("invalid_xdr");
    }

    let hasSorobanInvocation = false;
    let authorizationEntries: xdr.SorobanAuthorizationEntry[] = [];

    const operations = tx.operations();
    if (operations) {
      for (const op of operations) {
        if (op.body().switch().name === "invokeHostFunction") {
          hasSorobanInvocation = true;
          const hostFn = op.body().invokeHostFunctionOp();
          if (hostFn) {
            const auth = hostFn.hostFunction().invokeContractArgs()?.auth();
            if (auth) {
              authorizationEntries = Array.from(auth);
            }
          }
        }
      }
    }

    if (!hasSorobanInvocation) {
      return err("not_soroban");
    }

    if (authorizationEntries.length === 0) {
      return err("no_authorization");
    }

    const decodedEntries: SorobanAuthorizationTreeNode[] = [];
    let unobviousCount = 0;

    for (const entry of authorizationEntries) {
      const result = decodeSorobanAuthorizationEntry(entry);
      if (result.ok) {
        decodedEntries.push(result.value);
      } else {
        return err("auth_unreadable");
      }
    }

    return ok({
      authorizationEntries: decodedEntries,
      totalEntries: decodedEntries.length,
      unobviousEntries: unobviousCount,
    });
  } catch {
    return err("invalid_xdr");
  }
}
