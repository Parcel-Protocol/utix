export type SorobanSpecViewerErrorCode =
  | "empty_input"
  | "invalid_address"
  | "network_error"
  | "contract_not_found"
  | "spec_not_available"
  | "spec_unreadable"
  | "rpc_error";

export interface ScSpecUdt {
  name: string;
  doc?: string;
  fields: ScSpecUdtField[];
}

export interface ScSpecUdtField {
  name: string;
  type: string;
}

export interface ScSpecError {
  name: string;
  doc?: string;
  code: number;
}

export interface ScSpecFunctionArg {
  name: string;
  type: string;
}

export interface ScSpecFunction {
  name: string;
  doc?: string;
  args: ScSpecFunctionArg[];
  returns: string;
}

export interface SorobanContractSpec {
  contractId: string;
  wasmHash: string;
  functions: ScSpecFunction[];
  types: ScSpecUdt[];
  errors: ScSpecError[];
}

export interface SorobanSpecViewerInput {
  contractAddress: string;
  network: "mainnet" | "testnet";
}
