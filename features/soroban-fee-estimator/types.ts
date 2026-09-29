export type SorobanFeeEstimatorErrorCode =
  | "empty_input"
  | "invalid_base64"
  | "invalid_xdr"
  | "not_soroban"
  | "no_resources"
  | "pricing_unavailable"
  | "rpc_error"
  | "request_failed";

export interface ResourceFeeComponent {
  name: string;
  resourceCount: string;
  unitPrice: string;
  totalFee: string;
}

export interface SorobanResourceFeeEstimate {
  declaredFee: string;
  estimatedFee: string;
  difference: string;
  status: "sufficient" | "insufficient";
  components: {
    cpuInstructions: ResourceFeeComponent;
    memoryBytes: ResourceFeeComponent;
    ledgerReadBytes: ResourceFeeComponent;
    ledgerWriteBytes: ResourceFeeComponent;
    ledgerRentBytes: ResourceFeeComponent;
  };
}

export interface SorobanFeeEstimatorInput {
  envelope: string;
  network: "mainnet" | "testnet";
}
