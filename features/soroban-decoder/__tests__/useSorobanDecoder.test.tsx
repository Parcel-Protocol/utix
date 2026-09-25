import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { NetworkProvider } from "@/core/network/NetworkProvider";
import { useSorobanDecoder } from "@/features/soroban-decoder/hooks/useSorobanDecoder";

function wrapper({ children }: { children: React.ReactNode }) {
  return <NetworkProvider initialNetwork="testnet">{children}</NetworkProvider>;
}

describe("useSorobanDecoder", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useSorobanDecoder(), { wrapper });
    expect(result.current.state.status).toBe("idle");
  });
});
