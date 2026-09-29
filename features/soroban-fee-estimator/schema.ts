import { z } from "zod";

export const SorobanFeeEstimatorInputSchema = z.object({
  envelope: z.string().min(1, "Envelope cannot be empty"),
});

export type SorobanFeeEstimatorInput = z.infer<typeof SorobanFeeEstimatorInputSchema>;
