import type { OperationBrowserErrorCode } from "@/features/operation-browser/types";

export const copy = {
  formLabel: "Account address",
  formHint: "The account whose operation history you want to browse, starting with G.",
  submit: "Browse operations",
  loading: "Loading operations...",
  loadingPage: "Loading more operations...",
  retry: "Try again",
  emptyTitle: "No operation history loaded yet",
  emptyDescription:
    "Enter a funded account address to browse its recent operations from Horizon, filter by type, and page through older entries.",
  resultTitle: "Operation history",
  filterLabel: "Operation type",
  filterAll: "All types",
  loadOlder: "Load more",
  loadNewer: "Show newer",
  noOperationsTitle: "No operations on this page",
  noOperationsDescription: "This account has no operations on the selected network, or the filter removed every loaded row.",
  operationListLabel: "Loaded operations",
  resultsAnnouncement: (count: number, page: number) =>
    `${count} operation${count === 1 ? "" : "s"} shown on page ${page}.`,
  failedOperation: "Failed in transaction",
  successfulOperation: "Succeeded in transaction",
  paramsTitle: "Details",
  notificationFailureTitle: "Operation history needs attention",
  notificationFailureMessage: (reason: string) => `The history request could not be completed: ${reason}.`,
  notificationRetryTitle: "Retrying operation history",
  notificationRetryMessage: "The last history request is being retried.",
  notificationCompletedTitle: "Operation history loaded",
  notificationCompletedMessage: (count: number) => `${count} operation${count === 1 ? "" : "s"} loaded.`,
  notificationRecoveryTitle: "Operation history recovered",
  notificationRecoveryMessage: "The account history is available again after a failed request.",
  notificationHref: (accountId: string) =>
    `/tools/operation-browser?account=${encodeURIComponent(accountId)}`,
  pagePosition: (page: number, total: number) => `Page ${page} of ${total}`
} as const;

export const errorCopy: Record<OperationBrowserErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Enter an account address",
    description: "Paste the public address of the account whose operations you want to inspect."
  },
  invalid_address: {
    title: "The account address is not valid",
    description:
      "It must be a Stellar public address starting with G that passes the checksum. Never paste a secret key that starts with S."
  },
  account_not_found: {
    title: "This account does not exist on the selected network",
    description:
      "Accounts only exist once they are funded. Confirm the network switch in the header matches where the account lives."
  },
  rate_limited: {
    title: "Horizon is rate limiting this request",
    description: "Wait a moment before browsing again."
  },
  request_failed: {
    title: "Could not reach Horizon",
    description: "The request did not complete. Check your connection and try again."
  }
};
