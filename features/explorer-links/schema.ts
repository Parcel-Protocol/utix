import { z } from "zod";

export const ExplorerLinksInputSchema = z.object({
  identifier: z.string().min(1, "Identifier cannot be empty"),
  network: z.enum(["mainnet", "testnet"]),
});

export type ExplorerLinksInput = z.infer<typeof ExplorerLinksInputSchema>;
