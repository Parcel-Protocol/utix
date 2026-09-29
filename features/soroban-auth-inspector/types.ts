export type SorobanAuthInspectorErrorCode =
  | "empty_input"
  | "invalid_base64"
  | "invalid_xdr"
  | "not_soroban"
  | "no_authorization"
  | "auth_unreadable";

export interface SorobanInvocationNode {
  contractAddress: string;
  functionName: string;
  args: ScValNode[];
  children: SorobanAuthorizationTreeNode[];
}

export interface ScValNode {
  type: string;
  value: string;
  children?: ScValNode[];
}

export interface SourceAccountCredentials {
  type: "source_account";
}

export interface AddressCredentials {
  type: "address";
  address: string;
  nonce: string;
  expiryLedger: number;
}

export type Credentials = SourceAccountCredentials | AddressCredentials;

export interface SorobanAuthorizationTreeNode {
  credentials: Credentials;
  rootInvocation: SorobanInvocationNode;
  /**
   * Flag indicating if this authorization entry authorizes a sub-invocation
   * not obviously implied by the top-level call
   */
  impliesUnobviousSubInvocation: boolean;
}

export interface SorobanAuthInspectorResult {
  authorizationEntries: SorobanAuthorizationTreeNode[];
  totalEntries: number;
  unobviousEntries: number;
}

export interface SorobanAuthInspectorInput {
  envelope: string;
}
