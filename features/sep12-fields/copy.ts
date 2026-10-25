import type { Sep12FieldsErrorCode } from "@/features/sep12-fields/types";

export const copy = {
  formLabel: "Search SEP-9 / SEP-12 fields",
  formHint: "Search by exact field name, type, or description. The reference is local and curated.",
  submit: "Search",
  emptyTitle: "No field selected",
  emptyDescription: "Search the standard KYC names that anchors commonly request.",
  resultTitle: "Matching KYC fields"
} as const;

export const errorCopy: Record<Sep12FieldsErrorCode, { title: string; description: string }> = {
  empty_input: { title: "Enter a search term", description: "Try a standard field name such as country or birth_date." },
  not_found: { title: "No matching fields", description: "Try a broader name or type." }
};
