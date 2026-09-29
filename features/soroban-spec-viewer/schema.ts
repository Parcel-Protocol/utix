import { z } from "zod";

export const SorobanSpecViewerInputSchema = z.object({
  contractAddress: z.string().min(1, "Address cannot be empty"),
  network: z.enum(["mainnet", "testnet"]),
});

export type SorobanSpecViewerInput = z.infer<typeof SorobanSpecViewerInputSchema>;
