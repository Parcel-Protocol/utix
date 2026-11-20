export type ScValJson =
  | { type: "void" }
  | { type: "bool"; value: boolean }
  | { type: "u32" | "i32" | "u64" | "i64" | "u128" | "i128" | "u256" | "i256" | "timepoint" | "duration"; value: string }
  | { type: "string" | "symbol" | "bytes" | "address"; value: string }
  | { type: "vec"; value: ScValJson[] }
  | { type: "map"; value: Array<{ key: ScValJson; value: ScValJson }> };

export interface ScvalCodecInput { value: string; }
export interface ScvalCodecResult { direction: "encoded" | "decoded"; base64: string; json: ScValJson; }
export type ScvalCodecErrorCode = "empty_input" | "invalid_input" | "unsupported_type";
