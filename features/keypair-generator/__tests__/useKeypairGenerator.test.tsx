import { describe, expect, it } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { NetworkProvider } from "@/core/network/NetworkProvider";
import { useKeypairGenerator } from "@/features/keypair-generator/hooks/useKeypairGenerator";

function wrapper({ children }: { children: React.ReactNode }) {
  return <NetworkProvider initialNetwork="testnet">{children}</NetworkProvider>;
}

describe("useKeypairGenerator", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useKeypairGenerator(), { wrapper });
    expect(result.current.state.status).toBe("idle");
  });

  it("generates a keypair without input", async () => {
    const { result } = renderHook(() => useKeypairGenerator(), { wrapper });
    await act(async () => {
      await result.current.submit("");
    });
    await waitFor(() => expect(result.current.state.status).toBe("success"));
  });
});
