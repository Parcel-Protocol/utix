import { err, ok, type Result } from "@/core/result/result";
import type { StellarNetwork } from "@/core/network/types";
import type { Sep12Field, Sep12FieldsErrorCode, Sep12FieldsInput, Sep12FieldsResult } from "@/features/sep12-fields/types";

export const SEP12_FIELDS: readonly Sep12Field[] = [
  { name: "family_name", type: "string", description: "Family or last name.", required: true },
  { name: "given_name", type: "string", description: "Given or first name.", required: true },
  { name: "birth_date", type: "date", description: "Date of birth in YYYY-MM-DD format.", required: true },
  { name: "address", type: "string", description: "Residential address.", required: false },
  { name: "city", type: "string", description: "City of residence.", required: false },
  { name: "state_or_province", type: "string", description: "State, province, or region.", required: false },
  { name: "postal_code", type: "string", description: "Postal or ZIP code.", required: false },
  { name: "country", type: "string", description: "Two-letter ISO 3166 country code.", required: true },
  { name: "id_number", type: "string", description: "Government identity document number.", required: false },
  { name: "id_type", type: "string", description: "Government identity document type.", required: false },
  { name: "id_country_code", type: "string", description: "Issuing country code for the identity document.", required: false },
  { name: "id_expiration_date", type: "date", description: "Identity document expiration date.", required: false },
  { name: "photo_id_front", type: "binary", description: "Front image of an identity document.", required: false },
  { name: "photo_id_back", type: "binary", description: "Back image of an identity document.", required: false },
  { name: "email_address", type: "string", description: "Email address.", required: false },
  { name: "mobile_number", type: "string", description: "Mobile telephone number.", required: false },
  { name: "occupation", type: "string", description: "Occupation or employment.", required: false },
  { name: "organization", type: "string", description: "Registered organization name for business KYC.", required: false },
  { name: "tax_id", type: "string", description: "Tax identification number.", required: false }
];

/** Core tool logic. Never throws for expected failures — returns a Result. */
export async function runSep12Fields(
  input: Sep12FieldsInput,
  _network: StellarNetwork,
  _signal?: AbortSignal
): Promise<Result<Sep12FieldsResult, Sep12FieldsErrorCode>> {
  const query = input.value.toLowerCase();
  const fields = SEP12_FIELDS.filter((field) =>
    `${field.name} ${field.type} ${field.description}`.toLowerCase().includes(query)
  );
  return fields.length ? ok({ query: input.value, fields }) : err("not_found");
}
