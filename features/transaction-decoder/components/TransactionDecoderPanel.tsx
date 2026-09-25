import { Alert } from "@/core/ui/Alert";
import { TransactionDecoderEmptyState } from "@/features/transaction-decoder/components/TransactionDecoderEmptyState";
import { TransactionDecoderForm } from "@/features/transaction-decoder/components/TransactionDecoderForm";
import { TransactionDecoderResult } from "@/features/transaction-decoder/components/TransactionDecoderResult";
import { errorCopy } from "@/features/transaction-decoder/copy";
import { useTransactionDecoder } from "@/features/transaction-decoder/hooks/useTransactionDecoder";
import { mapTransactionDecoderError } from "@/features/transaction-decoder/lib/transactionDecoder.errors";

export function TransactionDecoderPanel() {
  const { state, submit } = useTransactionDecoder();

  return (
    <div className="space-y-6">
      <TransactionDecoderForm onSubmit={submit} pending={state.status === "pending"} />

      {state.status === "error" ? (
        <Alert
          variant="danger"
          title={errorCopy[state.code].title}
          description={mapTransactionDecoderError(state.code)}
        />
      ) : null}

      {state.status === "success" ? <TransactionDecoderResult result={state.result} /> : null}

      {state.status === "idle" ? <TransactionDecoderEmptyState /> : null}
    </div>
  );
}
