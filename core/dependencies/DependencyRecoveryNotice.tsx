import { StatusMessage } from "@/core/ui/StatusMessage";
import { Button } from "@/core/ui/Button";

export interface DependencyRecoveryNoticeProps {
  readonly dependency: string;
  readonly message: string;
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
}

export function DependencyRecoveryNotice({
  dependency,
  message,
  retrying = false,
  onRetry
}: DependencyRecoveryNoticeProps) {
  return (
    <div data-dependency={dependency} role="status" aria-live="polite">
      <StatusMessage
        type="warning"
        title={retrying ? "Recovering dependency" : "Dependency degraded"}
        description={
          <div className="space-y-3">
            <p>{message}</p>
            {onRetry ? (
              <Button type="button" onClick={onRetry} disabled={retrying}>
                {retrying ? "Retrying..." : "Retry"}
              </Button>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
