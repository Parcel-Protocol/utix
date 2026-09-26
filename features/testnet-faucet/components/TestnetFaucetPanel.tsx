"use client";

import { useEffect, useRef } from "react";
import { Card } from "@/core/ui/Card";
import { SkeletonRows } from "@/core/ui/Skeleton";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useNetwork } from "@/core/network/NetworkProvider";
import { useTestnetFaucet } from "@/features/testnet-faucet/hooks/useTestnetFaucet";
import { copy, errorCopy } from "@/features/testnet-faucet/copy";
import { TestnetFaucetForm } from "@/features/testnet-faucet/components/TestnetFaucetForm";
import { TestnetFaucetResult } from "@/features/testnet-faucet/components/TestnetFaucetResult";
import { TestnetFaucetEmptyState } from "@/features/testnet-faucet/components/TestnetFaucetEmptyState";

export function TestnetFaucetPanel() {
  const { state, submit } = useTestnetFaucet();
  const { network, epoch } = useNetwork();

  const warningRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const formInputRef = useRef<HTMLInputElement>(null);

  const prevStatusRef = useRef(state.status);

  useEffect(() => {
    if (epoch > 0) {
      if (network !== "testnet") {
        warningRef.current?.focus();
      } else {
        formInputRef.current?.focus();
      }
    }
  }, [epoch, network]);

  useEffect(() => {
    // Only move focus when transitioning out of funding
    if (prevStatusRef.current === "funding") {
      if (state.status === "error") {
        errorRef.current?.focus();
      } else if (state.status === "success") {
        successRef.current?.focus();
      }
    }
    prevStatusRef.current = state.status;
  }, [state.status]);

  return (
    <div className="space-y-5">
      {network !== "testnet" ? (
        <StatusMessage
          ref={warningRef}
          tabIndex={-1}
          type="warning"
          title={copy.mainnetWarning}
        />
      ) : null}

      <Card>
        <TestnetFaucetForm
          ref={formInputRef}
          onSubmit={submit}
          pending={state.status === "funding"}
        />
      </Card>

      {state.status === "funding" ? (
        <Card>
          <p className="sr-only" role="status">
            {copy.loading}
          </p>
          <SkeletonRows rows={2} />
        </Card>
      ) : null}

      {state.status === "error" ? (
        <StatusMessage
          ref={errorRef}
          tabIndex={-1}
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? (
        <div ref={successRef} tabIndex={-1} className="focus:outline-none">
          <TestnetFaucetResult result={state.result} />
        </div>
      ) : null}

      {state.status === "idle" ? <TestnetFaucetEmptyState /> : null}
    </div>
  );
}
