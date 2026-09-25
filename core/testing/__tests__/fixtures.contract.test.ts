import { describe, expect, it } from "vitest";
import { discoverFixtureFiles } from "@/core/testing/fixtureRegistry";

/**
 * SDK-upgrade fixture contract (issue #26).
 *
 * Fixtures are intentionally decentralized — one `fixtures/` directory per
 * feature slice, owned by that slice's contributor — so there is no single
 * fixtures root to hand-audit after a `@stellar/stellar-sdk` bump. Most
 * fixtures call real SDK constructors (`Keypair`, `TransactionBuilder`,
 * `xdr.*`) at module-evaluation time rather than hand-typing values, which
 * means a renamed export, changed constructor signature, or removed enum
 * member throws the moment the fixture module loads — this test just needs
 * to load every one of them and surface exactly which file broke.
 *
 * Deliberately-invalid fixture *values* (e.g. `notAnEnvelopeXdr`,
 * `notBase64`) are untouched by this: they're plain strings a slice's own
 * tests decode and expect to fail, not something this contract should flag.
 */
describe("fixture SDK-upgrade contract", () => {
  const fixtures = discoverFixtureFiles();

  it("discovers at least one fixture per feature slice with a fixtures directory", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [f.relativePath, f] as const))(
    "%s imports cleanly against the installed SDK",
    async (_label, fixture) => {
      await expect(
        import(/* @vite-ignore */ fixture.absolutePath)
      ).resolves.toBeDefined();
    }
  );
});
