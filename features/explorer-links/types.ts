export type IdentifierType = "account" | "transaction" | "ledger" | "asset" | "contract" | "unknown";

export type Explorer = "stellar.expert" | "stellar.chain.com" | "testnet.stellar.expert" | "steexp";

export interface ExplorerLink {
  explorer: Explorer;
  name: string;
  url: string;
}

export interface ExplorerLinksResult {
  identifier: string;
  type: IdentifierType;
  links: ExplorerLink[];
}

export interface ExplorerLinksInput {
  identifier: string;
  network: "mainnet" | "testnet";
}

export type ExplorerLinksErrorCode = "empty_input" | "unknown_identifier";
