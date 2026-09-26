import { describe, expect, it } from "vitest";
import { renderFeature, screen, waitFor } from "@/core/testing/render";
import { withMswHandlers } from "@/core/testing/msw";
import { TestnetFaucetPanel } from "@/features/testnet-faucet/components/TestnetFaucetPanel";
import { copy, errorCopy } from "@/features/testnet-faucet/copy";
import { handlers } from "@/features/testnet-faucet/msw/handlers";
import {
  fundedAccountId,
  newAccountId
} from "@/features/testnet-faucet/fixtures/testnetFaucet.fixture";

withMswHandlers(...handlers);

import { useNetwork } from "@/core/network/NetworkProvider";

function FaucetNetworkHarness() {
  const { setNetwork } = useNetwork();
  return (
    <>
      <button type="button" onClick={() => setNetwork("mainnet")}>
        Switch to mainnet
      </button>
      <button type="button" onClick={() => setNetwork("testnet")}>
        Switch to testnet
      </button>
      <TestnetFaucetPanel />
    </>
  );
}

describe("TestnetFaucetPanel", () => {
  it("shows the empty state first", () => {
    renderFeature(<TestnetFaucetPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("confirms a funded account and links to the explorer", async () => {
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), newAccountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(copy.successTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.viewOnExplorer })).toHaveAttribute(
      "href",
      expect.stringContaining("testnet")
    );
  });

  it("explains that an existing account cannot be funded again", async () => {
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), fundedAccountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(errorCopy.already_funded.title)).toBeInTheDocument();
  });

  it("warns that the faucet stays on testnet when mainnet is selected", () => {
    renderFeature(<TestnetFaucetPanel />, { network: "mainnet" });
    expect(screen.getByText(copy.mainnetWarning)).toBeInTheDocument();
  });

  it("does not warn while testnet is selected", () => {
    renderFeature(<TestnetFaucetPanel />, { network: "testnet" });
    expect(screen.queryByText(copy.mainnetWarning)).not.toBeInTheDocument();
  });

  it("moves focus to warning banner on network switch and returns focus on revert", async () => {
    const { user } = renderFeature(<FaucetNetworkHarness />, { network: "testnet" });

    // Switch network to mainnet
    await user.click(screen.getByRole("button", { name: "Switch to mainnet" }));
    const warning = screen.getByText(copy.mainnetWarning).closest("[role='status']");
    await waitFor(() => expect(document.activeElement).toBe(warning));

    // Switch back to testnet
    await user.click(screen.getByRole("button", { name: "Switch to testnet" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(copy.formLabel)));
  });

  it("moves focus to error message on funding failure", async () => {
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), fundedAccountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    const error = await screen.findByText(errorCopy.already_funded.title);
    const errorBox = error.closest("[role='alert']");
    expect(document.activeElement).toBe(errorBox);
  });

  it("moves focus to success result on funding success", async () => {
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), newAccountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    await screen.findByText(copy.successTitle);
    expect(document.activeElement).toHaveTextContent(copy.successTitle);
  });
});
