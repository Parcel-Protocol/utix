export {
  DEFAULT_STUCK_AFTER_MS,
  stuckOperations,
  summarizeOperation,
  type DiagnoseOperationsOptions,
  type OperationSummary,
  type StuckOperation
} from "@/core/operations/diagnostics";

export {
  abandonOperation,
  abandonOperationAuthorized,
  decideStep,
  defaultIdempotencyKey,
  nextActionFor,
  operationMachine,
  resolveInterruptedStep,
  resolveInterruptedStepAuthorized,
  rollbackOperation,
  rollbackOperationAuthorized,
  runOperation,
  type ResolveOperationOptions,
  type StepDecision,
  type StepResolution
} from "@/core/operations/recovery";

export {
  createAdapterOperationStorage,
  createOperationStorage,
  isOperationRecord,
  OPERATION_STORAGE_PREFIX,
  type OperationStorageAdapter
} from "@/core/operations/storage";

export {
  OPERATION_STATES,
  STEP_STATUSES,
  TERMINAL_OPERATION_STATES,
  type OperationDefinition,
  type OperationErrorCode,
  type OperationEvent,
  type OperationOutcomeState,
  type OperationProgress,
  type OperationRecord,
  type OperationState,
  type OperationStorage,
  type RecoveryAction,
  type RecoveryActionCode,
  type RunOperationOptions,
  type StepCheckpoint,
  type StepDefinition,
  type StepOutcome,
  type StepRollbackInput,
  type StepRollbackOutcome,
  type StepRunInput,
  type StepStatus
} from "@/core/operations/types";
export { createSideEffectDispatcher, type DispatchJob, type DispatchStore, type DispatchStatus, type SideEffectDispatcherOptions } from "./dispatcher";

export {
  classifyPartialFailure,
  executeOperatorAction,
  getOperatorDashboard,
  isUnresolvedPartialFailure,
  type OperatorActionKind,
  type OperatorActionRequest,
  type OperatorActionResult,
  type OperatorDashboardErrorCode,
  type OperatorDashboardFilter,
  type OperatorDashboardItem,
  type OperatorDashboardOptions,
  type OperatorDashboardSnapshot,
  type PartialFailureCategory,
  type PartialFailureSeverity
} from "@/core/operations/operator-dashboard";

export {
  createOperationCancellationManager,
  type OperationCancellationErrorCode,
  type OperationCancellationManager,
  type OperationCancellationOptions,
  type OperationCancellationReport,
  type OperationCancellationStatus,
  type OperationCleanupHandler,
  type OperationCleanupStep,
  type OperationCleanupStepStatus
} from "@/core/operations/cancellation";

export {
  createMemoryDurableCheckpointStore,
  executeWithDurableCheckpoint,
  resolveInDoubtCheckpoint,
  resolveInDoubtCheckpointAuthorized,
  type DurableCheckpointPhase,
  type DurableCheckpointStore,
  type DurableSideEffectCheckpoint,
  type ExecuteSideEffectInput,
  type ExternalReceipt,
  type SideEffectExecutionErrorCode
} from "@/core/operations/durable-checkpoints";


