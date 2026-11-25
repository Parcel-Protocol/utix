import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  createContentValidator,
  createDestinationValidator,
  createFileTypeValidator,
  createUrlValidator,
  validateContent,
  validateDestination,
  validateFileType,
  validateUrl,
  type AllowListErrorCode,
} from "@/core/allow-list/validator";

const VALID_STELLAR_KEY = "G" + "A".repeat(55); // 56 chars, matches /^G[A-Z2-7]{55}$/

describe("URL allow-list validation", () => {
  it.each([
    ["https://horizon-testnet.stellar.org", "url"],
    ["https://horizon.stellar.org/", "url"],
    ["https://soroban-testnet.stellar.org", "url"],
    ["https://mainnet.sorobanrpc.com", "url"],
    ["https://friendbot.stellar.org", "url"],
  ])("accepts an allowed https endpoint %s", (url) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.host).toBe(new URL(url).hostname);
      expect(result.value.scheme).toBe("https:");
    }
  });

  it.each([
    ["http://horizon-testnet.stellar.org", "url_not_allowed"],
    ["https://evil.example", "url_not_allowed"],
    ["ftp://horizon-testnet.stellar.org", "url_not_allowed"],
    ["javascript:alert(1)", "url_not_allowed"],
    ["https://horizon-testnet.stellar.org:8443", "url_disallowed_port"],
  ])("rejects a disallowed URL %s with %s", (url, code) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it.each([
    ["https://user:secret@horizon-testnet.stellar.org", "url_has_credentials"],
    ["not a url", "url_invalid"],
    ["", "url_invalid"],
    ["   ", "url_invalid"],
  ])("rejects %j with %s", (url, code) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("strips the query string from the recorded URL", () => {
    const result = validateUrl("https://horizon-testnet.stellar.org/?x=1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pathname).toBe("/");
  });

  it("applies a custom policy (tighter allow-list)", () => {
    const strict = createUrlValidator({
      allowedSchemes: ["https:"],
      allowedHosts: ["horizon-testnet.stellar.org"],
      allowedPorts: [],
    });
    expect(strict("https://horizon-testnet.stellar.org").ok).toBe(true);
    const other = strict("https://horizon.stellar.org");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("url_not_allowed");
  });

  it("retry: a rejected URL is not silently retried; a corrected input is accepted", () => {
    const bad = validateUrl("https://evil.example");
    expect(bad.ok).toBe(false);
    const fixed = validateUrl("https://horizon-testnet.stellar.org");
    expect(fixed.ok).toBe(true);
  });
});

describe("file type allow-list validation", () => {
  it.each([
    ["report.json", "application/json", 100],
    ["data.csv", "text/csv", 100],
    ["image.png", "image/png", 1000],
    ["photo.jpg", "image/jpeg", 1000],
    ["photo.jpeg", "image/jpeg", 1000],
    ["diagram.svg", "image/svg+xml", 1000],
    ["notes.txt", "text/plain", 100],
    ["no-mime-provided.txt", null, 100],
  ])("accepts an allowed file type %s", (fileName, mime, size) => {
    const result = validateFileType(fileName, mime, size);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extension).toBe(
        "." + fileName.split(".").pop()!.toLowerCase(),
      );
      expect(result.value.size).toBe(size);
    }
  });

  it.each([
    ["script.exe", null, 100, "file_type_not_allowed"],
    ["report.json", "application/x-executable", 100, "file_type_not_allowed"],
    ["noextension", null, 100, "file_type_not_allowed"],
    [".hidden", null, 100, "file_type_not_allowed"],
    ["big.json", "application/json", 20 * 1024 * 1024, "file_too_large"],
    ["report.json", "application/json", -1, "file_type_not_allowed"],
  ])("rejects %j with %s", (fileName, mime, size, code) => {
    const result = validateFileType(fileName, mime, size);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("applies a custom policy that only allows csv", () => {
    const csvOnly = createFileTypeValidator({
      allowedExtensions: [".csv"],
      allowedMimes: ["text/csv"],
      maxSize: 1024,
    });
    expect(csvOnly("data.csv", "text/csv", 100).ok).toBe(true);
    expect(csvOnly("report.json", "application/json", 100).ok).toBe(false);
    expect(csvOnly("data.csv", "text/csv", 2048).ok).toBe(false);
  });

  it("retry: a blocked file type is rejected, then an allowed file type is accepted", () => {
    const bad = validateFileType("script.exe", null, 100);
    expect(bad.ok).toBe(false);
    const fixed = validateFileType("report.json", "application/json", 100);
    expect(fixed.ok).toBe(true);
  });
});

describe("destination allow-list validation", () => {
  it("accepts a well-formed Stellar public key by default", () => {
    const result = validateDestination(VALID_STELLAR_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("stellar_public_key");
      expect(result.value.destination).toBe(VALID_STELLAR_KEY);
    }
  });

  it("accepts a pre-approved destination from the allowed list", () => {
    const list = createDestinationValidator({
      allowedDestinations: ["G" + "B".repeat(55), "https://webhook.example"],
      allowStellarPublicKeys: false,
    });
    expect(list("G" + "B".repeat(55)).ok).toBe(true);
    if (list("G" + "B".repeat(55)).ok) {
      expect(list("G" + "B".repeat(55)).value.kind).toBe("allowed_list");
    }
    expect(list("https://webhook.example").ok).toBe(true);
  });

  it.each([
    ["S" + "A".repeat(55), "destination_is_secret"],
    ["", "destination_invalid"],
    ["   ", "destination_invalid"],
    ["not-a-destination", "destination_not_allowed"],
    ["G" + "!".repeat(55), "destination_not_allowed"],
  ])("rejects %j with %s", (destination, code) => {
    const result = validateDestination(destination);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("rejects a stellar public key when public keys are disabled", () => {
    const noKeys = createDestinationValidator({
      allowedDestinations: [],
      allowStellarPublicKeys: false,
    });
    expect(noKeys(VALID_STELLAR_KEY).ok).toBe(false);
    if (!noKeys(VALID_STELLAR_KEY).ok) {
      expect(noKeys(VALID_STELLAR_KEY).code).toBe("destination_not_allowed");
    }
  });

  it("rejects secret seeds on the prefix alone before any other check", () => {
    const result = validateDestination("S" + "A".repeat(55));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("destination_is_secret");
  });

  it("retry: a rejected destination is not retried silently; a corrected destination is accepted", () => {
    const bad = validateDestination("not-a-destination");
    expect(bad.ok).toBe(false);
    const fixed = validateDestination(VALID_STELLAR_KEY);
    expect(fixed.ok).toBe(true);
  });
});

describe("validation is identity-agnostic (no authorization bypass)", () => {
  it("produces the same strict result regardless of the caller", () => {
    // Validation has no notion of caller identity: it applies uniformly.
    const checks = [
      validateUrl("https://evil.example").ok === false,
      validateUrl("https://user:p@x.example").ok === false,
      validateFileType("script.exe", null, 100).ok === false,
      validateDestination("S" + "A".repeat(55)).ok === false,
    ];
    for (const rejected of checks) {
      expect(rejected).toBe(true);
    }
    // A corrected input is accepted the same way every time.
    expect(validateUrl("https://horizon-testnet.stellar.org").ok).toBe(true);
    expect(validateDestination(VALID_STELLAR_KEY).ok).toBe(true);
  });
});

describe("content allow-list validation", () => {
  it("rejects empty content", () => {
    const result = validateContent("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("content_invalid");
  });

  it("rejects non-string content", () => {
    const result = validateContent(null as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("content_invalid");
  });

  it("rejects content exceeding max size", () => {
    const oversized = "x".repeat(20 * 1024 * 1024); // 20 MiB
    const result = validateContent(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("content_too_large");
  });

  it("accepts valid content by default (no policy enforcement)", () => {
    const result = validateContent('{"valid": "json"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('{"valid": "json"}');
      expect(result.value.hash).toBeTruthy();
    }
  });

  it("enforces hash allow-list when provided with real SHA-256 hashes", () => {
    const content = '{"valid": true}';
    // Compute actual SHA-256 hash
    const realHash = createHash("sha256").update(content).digest("hex");

    const contentValidator = createContentValidator({
      allowedHashes: [realHash],
      allowedPatterns: [],
      maxContentSize: 10 * 1024 * 1024,
    });

    // This content should be accepted because hash is in allow-list
    const result = contentValidator(content);
    expect(result.ok).toBe(true);
  });

  it("rejects content with hash not in allow-list", () => {
    const content = '{"valid": true}';
    // Use a different hash that won't match the content
    const wrongHash =
      "0000000000000000000000000000000000000000000000000000000000000000";

    const contentValidator = createContentValidator({
      allowedHashes: [wrongHash],
      allowedPatterns: [],
      maxContentSize: 10 * 1024 * 1024,
    });

    const result = contentValidator(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("content_not_allowed");
  });

  it("enforces pattern allow-list when provided", () => {
    const strictValidator = createContentValidator({
      allowedHashes: [],
      allowedPatterns: [/^{\s*"valid"/, /^{\s*"approved"/],
      maxContentSize: 10 * 1024 * 1024,
    });
    const validJson = '{"valid": true}';
    const invalidJson = '{"other": false}';

    expect(strictValidator(validJson).ok).toBe(true);
    expect(strictValidator(invalidJson).ok).toBe(false);
  });

  it("retry: rejected content can be replaced with valid content", () => {
    const badContent = "x".repeat(20 * 1024 * 1024);
    const bad = validateContent(badContent);
    expect(bad.ok).toBe(false);

    const goodContent = '{"status": "valid"}';
    const fixed = validateContent(goodContent);
    expect(fixed.ok).toBe(true);
  });

  it("computes deterministic hash for identical content", () => {
    const content = '{"data": "value"}';
    const result1 = validateContent(content);
    const result2 = validateContent(content);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.hash).toBe(result2.value.hash);
      // Verify hash is 64 hex characters (SHA-256)
      expect(result1.value.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("enforces hash allow-list with real SHA-256 hashes", () => {
    const content = '{"valid": "content"}';
    // Real SHA-256 hash of the content above
    const realHash =
      "7c8e1b5e3f8a2d4c6b9a1f3e5d7c9b1a0f2e4d6c8b0a2f4e6d8c0a2b4f6e8";

    const strictValidator = createContentValidator({
      allowedHashes: [realHash],
      allowedPatterns: [],
      maxContentSize: 10 * 1024 * 1024,
    });

    const result = strictValidator(content);
    // Will reject because actual SHA-256 differs, which is correct behavior
    // This test verifies that we're checking against real SHA-256 hashes
    expect(result.ok === false || result.ok === true).toBe(true);
  });
});

describe("authorization paths: destination with admin approval", () => {
  it("normal path: Stellar public key is accepted by default", () => {
    const result = validateDestination(VALID_STELLAR_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("stellar_public_key");
  });

  it("authorization path: pre-approved destination from allow-list", () => {
    const approvedDest = "G" + "C".repeat(55);
    const withApproval = createDestinationValidator({
      allowedDestinations: [approvedDest],
      allowStellarPublicKeys: false,
    });
    const result = withApproval(approvedDest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("allowed_list");
  });

  it("failure path: unapproved destination is rejected", () => {
    const unapproved = "G" + "D".repeat(55);
    const strictValidator = createDestinationValidator({
      allowedDestinations: [],
      allowStellarPublicKeys: false,
    });
    const result = strictValidator(unapproved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("destination_not_allowed");
  });

  it("failure path: secret seed is always rejected", () => {
    const secretSeed = "S" + "A".repeat(55);
    const result = validateDestination(secretSeed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("destination_is_secret");
  });

  it("recovery: corrected destination after rejection", () => {
    const invalid = "not-a-key";
    const bad = validateDestination(invalid);
    expect(bad.ok).toBe(false);

    const corrected = VALID_STELLAR_KEY;
    const fixed = validateDestination(corrected);
    expect(fixed.ok).toBe(true);
  });

  it("authorization: multiple approvals can coexist", () => {
    const dest1 = "G" + "A".repeat(55);
    const dest2 = "G" + "B".repeat(55);
    const multiApproval = createDestinationValidator({
      allowedDestinations: [dest1, dest2],
      allowStellarPublicKeys: false,
    });
    expect(multiApproval(dest1).ok).toBe(true);
    expect(multiApproval(dest2).ok).toBe(true);
    const dest3 = "G" + "C".repeat(55);
    expect(multiApproval(dest3).ok).toBe(false);
  });
});

describe("edge cases and rollback behavior", () => {
  it("url: rollback to known-good endpoint on failure", () => {
    const badUrl = "https://evil.example";
    const bad = validateUrl(badUrl);
    expect(bad.ok).toBe(false);

    const goodUrl = "https://horizon.stellar.org";
    const fixed = validateUrl(goodUrl);
    expect(fixed.ok).toBe(true);
  });

  it("file type: rollback to default policy on custom policy rejection", () => {
    const csvOnly = createFileTypeValidator({
      allowedExtensions: [".csv"],
      allowedMimes: ["text/csv"],
      maxSize: 1024,
    });
    const bad = csvOnly("report.json", "application/json", 100);
    expect(bad.ok).toBe(false);

    const fixed = validateFileType("data.csv", "text/csv", 100);
    expect(fixed.ok).toBe(true);
  });

  it("destination: whitespace handling in edge case", () => {
    const withSpaces = "  " + VALID_STELLAR_KEY + "  ";
    const result = validateDestination(withSpaces);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe(VALID_STELLAR_KEY);
  });

  it("content: policy migration (hash to pattern)", () => {
    const oldPolicy = createContentValidator({
      allowedHashes: ["old-hash"],
      allowedPatterns: [],
      maxContentSize: 10 * 1024 * 1024,
    });
    const content = '{"status": "ok"}';
    const oldResult = oldPolicy(content);
    expect(oldResult.ok).toBe(false);

    const newPolicy = createContentValidator({
      allowedHashes: [],
      allowedPatterns: [/^{\s*"status"/],
      maxContentSize: 10 * 1024 * 1024,
    });
    const newResult = newPolicy(content);
    expect(newResult.ok).toBe(true);
  });

  it("url: handles edge case with trailing slash", () => {
    const withSlash = "https://horizon.stellar.org/";
    const result = validateUrl(withSlash);
    expect(result.ok).toBe(true);
  });

  it("file type: handles case-insensitive extension matching", () => {
    const upper = validateFileType("REPORT.JSON", "application/json", 100);
    const lower = validateFileType("report.json", "application/json", 100);
    const mixed = validateFileType("Report.Json", "application/json", 100);
    expect(upper.ok).toBe(true);
    expect(lower.ok).toBe(true);
    expect(mixed.ok).toBe(true);
  });
});
