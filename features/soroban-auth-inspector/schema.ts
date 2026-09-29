import { z } from "zod";

export const SorobanAuthInspectorInputSchema = z.object({
  envelope: z.string().min(1, "Envelope cannot be empty"),
});

export type SorobanAuthInspectorInput = z.infer<typeof SorobanAuthInspectorInputSchema>;
