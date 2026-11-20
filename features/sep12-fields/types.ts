export interface Sep12Field { name: string; type: "string" | "date" | "binary"; description: string; required: boolean; }
export interface Sep12FieldsInput { value: string; }
export interface Sep12FieldsResult { query: string; fields: Sep12Field[]; }
export type Sep12FieldsErrorCode = "empty_input" | "not_found";
