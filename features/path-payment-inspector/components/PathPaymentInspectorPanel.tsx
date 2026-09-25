"use client";

import { Card } from "@/core/ui/Card";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { usePathPaymentInspector } from "@/features/path-payment-inspector/hooks/usePathPaymentInspector";
import { errorCopy } from "@/features/path-payment-inspector/copy";
import { PathPaymentInspectorForm } from "@/features/path-payment-inspector/components/PathPaymentInspectorForm";
import { PathPaymentInspectorResult } from "@/features/path-payment-inspector/components/PathPaymentInspectorResult";
import { PathPaymentInspectorEmptyState } from "@/features/path-payment-inspector/components/PathPaymentInspectorEmptyState";

export function PathPaymentInspectorPanel() {
  const { state, submit } = usePathPaymentInspector();

  return (
    <div className="space-y-5">
      <Card>
        <PathPaymentInspectorForm onSubmit={submit} pending={state.status === "loading"} />
      </Card>

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? <PathPaymentInspectorResult result={state.result} /> : null}

      {state.status === "idle" ? <PathPaymentInspectorEmptyState /> : null}
    </div>
  );
}
