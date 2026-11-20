import { err, ok, type Result } from "@/core/result/result";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@/core/network/types";
import type { ScvalCodecErrorCode, ScvalCodecInput, ScvalCodecResult, ScValJson } from "@/features/scval-codec/types";

const INTEGER_TYPES = new Set(["u32", "i32", "u64", "i64", "u128", "i128", "u256", "i256", "timepoint", "duration"]);
function toNative(value: ScValJson): unknown {
  if (value.type === "void") return null;
  if (value.type === "bool") return value.value;
  if (INTEGER_TYPES.has(value.type)) return BigInt(value.value);
  if (value.type === "string" || value.type === "symbol" || value.type === "bytes" || value.type === "address") return value.value;
  if (value.type === "vec") return value.value.map(toNative);
  return value.value.map((entry) => [toNative(entry.key), toNative(entry.value)]);
}
function fromScVal(value: xdr.ScVal): ScValJson {
  const name = value.switch().name;
  if (name === "scvVoid") return { type: "void" };
  if (name === "scvBool") return { type: "bool", value: value.b() };
  if (name === "scvVec") return { type: "vec", value: (value.vec() ?? []).map(fromScVal) };
  if (name === "scvMap") return { type: "map", value: (value.map() ?? []).map((entry) => ({ key: fromScVal(entry.key()), value: fromScVal(entry.val()) })) };
  const native = scValToNative(value);
  const type = name.replace(/^scv/, "").toLowerCase() as ScValJson["type"];
  return { type, value: typeof native === "bigint" ? native.toString() : String(native) } as ScValJson;
}

/** Core tool logic. Never throws for expected failures — returns a Result. */
export async function runScvalCodec(
  input: ScvalCodecInput,
  _network: StellarNetwork,
  _signal?: AbortSignal
): Promise<Result<ScvalCodecResult, ScvalCodecErrorCode>> {
  try {
    const parsed = JSON.parse(input.value) as Partial<ScValJson>;
    if (parsed && typeof parsed.type === "string") {
      const encoded = nativeToScVal(toNative(parsed as ScValJson), { type: parsed.type as never });
      return ok({ direction: "encoded", base64: encoded.toXDR("base64"), json: parsed as ScValJson });
    }
    const decoded = xdr.ScVal.fromXDR(input.value, "base64");
    return ok({ direction: "decoded", base64: input.value, json: fromScVal(decoded) });
  } catch { return err("invalid_input"); }
}
