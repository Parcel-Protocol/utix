import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { NetworkProvider } from "@/core/network/NetworkProvider";
import { useTransactionDecoder } from "@/features/transaction-decoder/hooks/useTransactionDecoder";

function wrapper({ children }: { children: React.ReactNode }) {
  return <NetworkProvider initialNetwork="testnet">{children}</NetworkProvider>;
}

describe("useTransactionDecoder", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useTransactionDecoder(), { wrapper });
    expect(result.current.state.status).toBe("idle");
  });
});
