import { afterEach, describe, expect, it, vi } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { withMswHandlers } from "@/core/testing/msw";
import { TestnetFaucetPanel } from "@/features/testnet-faucet/components/TestnetFaucetPanel";
import { copy, errorCopy } from "@/features/testnet-faucet/copy";
import { handlers } from "@/features/testnet-faucet/msw/handlers";
import {
  fundedAccountId,
  newAccountId,
  rateLimitedAccountId,
  rejectedAddressAccountId,
  timedOutAccountId,
  upstreamErrorAccountId
} from "@/features/testnet-faucet/fixtures/testnetFaucet.fixture";

withMswHandlers(...handlers);

describe("TestnetFaucetPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it.each([
    [rejectedAddressAccountId, "invalid_address"],
    [timedOutAccountId, "timeout"],
    [upstreamErrorAccountId, "friendbot_unavailable"]
  ] as const)("shows distinct copy for %s (%s)", async (accountId, code) => {
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), accountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(errorCopy[code].title)).toBeInTheDocument();
    expect(screen.getByText(errorCopy[code].description)).toBeInTheDocument();
  });

  it("says it is retrying a rate limit and lets the user stop it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { user } = renderFeature(<TestnetFaucetPanel />);

    await user.type(screen.getByLabelText(copy.formLabel), rateLimitedAccountId);
    await user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(copy.waitingTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.loading })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: copy.cancelRetry }));
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("warns that the faucet stays on testnet when mainnet is selected", () => {
    renderFeature(<TestnetFaucetPanel />, { network: "mainnet" });
    expect(screen.getByText(copy.mainnetWarning)).toBeInTheDocument();
  });

  it("does not warn while testnet is selected", () => {
    renderFeature(<TestnetFaucetPanel />, { network: "testnet" });
    expect(screen.queryByText(copy.mainnetWarning)).not.toBeInTheDocument();
  });
});
