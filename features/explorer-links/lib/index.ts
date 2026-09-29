import type {
  IdentifierType,
  ExplorerLink,
  ExplorerLinksResult,
  ExplorerLinksInput,
  ExplorerLinksErrorCode,
} from "@/features/explorer-links/types";

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

function classifyIdentifier(input: string): IdentifierType {
  const trimmed = input.trim();

  // Contract (56 chars starting with C)
  if (trimmed.startsWith("C") && trimmed.length === 56) {
    return "contract";
  }

  // Account (56 chars starting with G)
  if (trimmed.startsWith("G") && trimmed.length === 56) {
    return "account";
  }

  // Muxed account (M prefix)
  if (trimmed.startsWith("M") && trimmed.length >= 56) {
    return "account";
  }

  // Transaction (64 char hex)
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return "transaction";
  }

  // Ledger (numeric)
  if (/^\d+$/.test(trimmed) && trimmed.length <= 10) {
    return "ledger";
  }

  // Asset (code:issuer format)
  if (trimmed.includes(":") && trimmed.split(":").length === 2) {
    const [code, issuer] = trimmed.split(":");
    if (
      code &&
      code.length > 0 &&
      code.length <= 12 &&
      issuer &&
      issuer.startsWith("G") &&
      issuer.length === 56
    ) {
      return "asset";
    }
  }

  return "unknown";
}

function buildExplorerLinks(
  identifier: string,
  type: IdentifierType,
  network: "mainnet" | "testnet",
): ExplorerLink[] {
  const links: ExplorerLink[] = [];
  const trimmed = identifier.trim();
  const isMocknet = network === "testnet";

  if (type === "account") {
    links.push({
      explorer: "stellar.expert",
      name: "Stellar Expert",
      url: `https://${isMocknet ? "testnet." : ""}stellar.expert/account/${trimmed}`,
    });
    links.push({
      explorer: "stellar.chain.com",
      name: "Stellar Chain",
      url: `https://${isMocknet ? "testnet-" : ""}stellar.chain.com/accounts/${trimmed}`,
    });
    links.push({
      explorer: "steexp",
      name: "SteExp",
      url: `https://${isMocknet ? "testnet." : ""}steexp.com/account/${trimmed}`,
    });
  } else if (type === "transaction") {
    links.push({
      explorer: "stellar.expert",
      name: "Stellar Expert",
      url: `https://${isMocknet ? "testnet." : ""}stellar.expert/tx/${trimmed}`,
    });
    links.push({
      explorer: "stellar.chain.com",
      name: "Stellar Chain",
      url: `https://${isMocknet ? "testnet-" : ""}stellar.chain.com/transactions/${trimmed}`,
    });
    links.push({
      explorer: "steexp",
      name: "SteExp",
      url: `https://${isMocknet ? "testnet." : ""}steexp.com/tx/${trimmed}`,
    });
  } else if (type === "ledger") {
    links.push({
      explorer: "stellar.expert",
      name: "Stellar Expert",
      url: `https://${isMocknet ? "testnet." : ""}stellar.expert/ledger/${trimmed}`,
    });
    links.push({
      explorer: "stellar.chain.com",
      name: "Stellar Chain",
      url: `https://${isMocknet ? "testnet-" : ""}stellar.chain.com/ledgers/${trimmed}`,
    });
    links.push({
      explorer: "steexp",
      name: "SteExp",
      url: `https://${isMocknet ? "testnet." : ""}steexp.com/ledger/${trimmed}`,
    });
  } else if (type === "asset") {
    const [code, issuer] = trimmed.split(":");
    links.push({
      explorer: "stellar.expert",
      name: "Stellar Expert",
      url: `https://${isMocknet ? "testnet." : ""}stellar.expert/asset/${code}-${issuer}`,
    });
    links.push({
      explorer: "stellar.chain.com",
      name: "Stellar Chain",
      url: `https://${isMocknet ? "testnet-" : ""}stellar.chain.com/assets/${code}-${issuer}`,
    });
  } else if (type === "contract") {
    links.push({
      explorer: "stellar.expert",
      name: "Stellar Expert",
      url: `https://${isMocknet ? "testnet." : ""}stellar.expert/contract/${trimmed}`,
    });
    links.push({
      explorer: "steexp",
      name: "SteExp",
      url: `https://${isMocknet ? "testnet." : ""}steexp.com/contract/${trimmed}`,
    });
  }

  return links;
}

export function parseExplorerLinksInput(
  input: string,
): Result<ExplorerLinksInput, ExplorerLinksErrorCode> {
  const trimmed = input.trim();

  if (!trimmed) {
    return err("empty_input");
  }

  // Determine network from input context (default to mainnet)
  return ok({
    identifier: trimmed,
    network: "mainnet",
  });
}

export function generateExplorerLinks(
  input: ExplorerLinksInput,
): Result<ExplorerLinksResult, ExplorerLinksErrorCode> {
  const type = classifyIdentifier(input.identifier);

  if (type === "unknown") {
    return err("unknown_identifier");
  }

  const links = buildExplorerLinks(input.identifier, type, input.network);

  return ok({
    identifier: input.identifier.trim(),
    type,
    links,
  });
}
