import type { SorobanDecoderResult } from "@/features/soroban-decoder/types";

export const sorobanDecoderFixture: SorobanDecoderResult = {
  contractId: "CB6E35C3E38805799D0F352B8897E8B3D3B5EA62719B585934FE233B",
  functionName: "transfer",
  specAvailable: true,
  argsTree: [
    {
      type: "Vec",
      value: "Vec[2]",
      children: [
        { type: "Symbol", value: "transfer" },
        { type: "U128", value: "100000000" }
      ]
    }
  ],
  simulation: {
    minResourceFee: "2500",
    cpuInstructions: "450000",
    memoryBytes: "131072",
    authEntriesCount: 1
  },
  readOnly: true,
  network: "testnet"
};
