/**
 * Keyboard and async-status accessibility coverage (#459).
 *
 * The repo already has keyboard primitives (`core/ui/accessibility.ts`), an
 * async announcer and axe helpers. What was missing is a single, deterministic
 * way to say "the normal, failure, retry and authorization paths were all
 * observed, and each one was accessible". This module is that coverage
 * ledger: it evaluates observations collected from a component or an E2E run
 * and reports exactly which path is missing or wrong.
 *
 * It is deliberately DOM-free so the same evaluator can run in Vitest, in a
 * Playwright reporter, and in the standalone verification script. Keyboard
 * observations describe focus order, activation and focus return; async
 * observations describe the live-region announcement and ARIA attributes for
 * a status. Expectations come from the shipped accessibility helpers rather
 * than being restated, so a helper change cannot silently invalidate a test.
 */

import {
  getStatusAnnouncement,
  getStatusAriaAttributes,
  getStatusLivePoliteness,
  type AsyncStatus
} from "@/core/ui/accessibility";

export const A11Y_PATHS = ["normal", "failure", "retry", "authorization"] as const;
export type A11yPath = (typeof A11Y_PATHS)[number];

export interface KeyboardObservation {
  readonly path: A11yPath;
  /** Control ids in the order a user reaches them with Tab. */
  readonly focusOrder: readonly string[];
  readonly expectedFocusOrder: readonly string[];
  readonly activatedControlId?: string;
  readonly expectedActivationId?: string;
  readonly focusReturnedToId?: string;
  readonly expectedFocusReturnId?: string;
}

export interface AsyncStatusObservation {
  readonly path: A11yPath;
  readonly status: AsyncStatus;
  /** What the live region actually said. */
  readonly announcement: string;
  readonly politeness: "polite" | "assertive" | "off";
  readonly role: string;
  readonly busy: boolean;
  readonly successMessage?: string;
  readonly errorMessage?: string;
}

export interface A11yCoverageIssue {
  readonly code: string;
  readonly message: string;
}

export interface A11yPathCoverage {
  readonly path: A11yPath;
  readonly passed: boolean;
  readonly issues: readonly A11yCoverageIssue[];
}

export interface A11yCoverageReport {
  readonly paths: readonly A11yPathCoverage[];
  readonly missingPaths: readonly A11yPath[];
  readonly ready: boolean;
}

export interface A11yCoverageInput {
  readonly keyboard: readonly KeyboardObservation[];
  readonly asyncStatus: readonly AsyncStatusObservation[];
}

/** Required status sequence, in order, for an async path to count as covered. */
const REQUIRED_STATUSES: Readonly<Record<A11yPath, readonly AsyncStatus[]>> = {
  normal: ["success"],
  failure: ["error"],
  retry: ["loading", "error", "success"],
  authorization: ["error"]
};

function containsSequence(actual: readonly AsyncStatus[], required: readonly AsyncStatus[]): boolean {
  let cursor = 0;
  for (const status of actual) {
    if (status === required[cursor]) cursor += 1;
    if (cursor === required.length) return true;
  }
  return required.length === 0;
}

export function evaluateKeyboardObservation(observation: KeyboardObservation): readonly A11yCoverageIssue[] {
  const issues: A11yCoverageIssue[] = [];
  if (observation.focusOrder.length === 0) {
    issues.push({ code: "keyboard_no_focusable_controls", message: "No keyboard-reachable controls were observed." });
  }
  if (observation.focusOrder.join(">") !== observation.expectedFocusOrder.join(">")) {
    issues.push({
      code: "keyboard_focus_order",
      message: `Focus order ${observation.focusOrder.join(" > ")} did not match ${observation.expectedFocusOrder.join(" > ")}.`
    });
  }
  if (
    observation.expectedActivationId !== undefined &&
    observation.activatedControlId !== observation.expectedActivationId
  ) {
    issues.push({
      code: "keyboard_activation",
      message: `Expected activation of ${observation.expectedActivationId}, observed ${observation.activatedControlId ?? "none"}.`
    });
  }
  if (
    observation.expectedFocusReturnId !== undefined &&
    observation.focusReturnedToId !== observation.expectedFocusReturnId
  ) {
    issues.push({
      code: "keyboard_focus_return",
      message: `Focus was not restored to ${observation.expectedFocusReturnId} after the async state changed.`
    });
  }
  return issues;
}

export function evaluateAsyncStatusObservation(observation: AsyncStatusObservation): readonly A11yCoverageIssue[] {
  const issues: A11yCoverageIssue[] = [];
  const expectedAnnouncement = getStatusAnnouncement(
    observation.status,
    observation.successMessage,
    observation.errorMessage
  );
  const attributes = getStatusAriaAttributes(observation.status);

  if (observation.announcement !== expectedAnnouncement) {
    issues.push({
      code: "async_announcement",
      message: `Announcement ${JSON.stringify(observation.announcement)} did not match ${JSON.stringify(expectedAnnouncement)}.`
    });
  }
  if (observation.politeness !== getStatusLivePoliteness(observation.status)) {
    issues.push({
      code: "async_politeness",
      message: `${observation.status} must use ${getStatusLivePoliteness(observation.status)}, observed ${observation.politeness}.`
    });
  }
  if (observation.role !== attributes.role) {
    issues.push({
      code: "async_role",
      message: `${observation.status} must use role ${attributes.role}, observed ${observation.role}.`
    });
  }
  if (observation.busy !== attributes["aria-busy"]) {
    issues.push({
      code: "async_busy",
      message: `${observation.status} must set aria-busy to ${attributes["aria-busy"]}, observed ${observation.busy}.`
    });
  }
  if (observation.status === "error" && observation.politeness !== "assertive") {
    issues.push({ code: "async_error_not_assertive", message: "Errors must interrupt with an assertive live region." });
  }
  return issues;
}

/**
 * Produce the coverage report. A path fails if either observation is absent,
 * the expected async status sequence never occurred, or any individual check
 * produced an issue.
 */
export function evaluateKeyboardAsyncCoverage(input: A11yCoverageInput): A11yCoverageReport {
  const paths: A11yPathCoverage[] = [];
  const missingPaths: A11yPath[] = [];

  for (const path of A11Y_PATHS) {
    const issues: A11yCoverageIssue[] = [];
    const keyboards = input.keyboard.filter((item) => item.path === path);
    const statuses = input.asyncStatus.filter((item) => item.path === path);

    if (keyboards.length === 0 || statuses.length === 0) {
      issues.push({
        code: "a11y_evidence_missing",
        message: `Missing ${keyboards.length === 0 ? "keyboard" : "async status"} observations for ${path}.`
      });
    }
    for (const observation of keyboards) issues.push(...evaluateKeyboardObservation(observation));
    for (const observation of statuses) issues.push(...evaluateAsyncStatusObservation(observation));
    if (!containsSequence(statuses.map((item) => item.status), REQUIRED_STATUSES[path])) {
      issues.push({
        code: "async_status_sequence",
        message: `${path} did not observe the required status sequence: ${REQUIRED_STATUSES[path].join(" -> ")}.`
      });
    }

    const passed = issues.length === 0;
    if (!passed) missingPaths.push(path);
    paths.push({ path, passed, issues });
  }

  return { paths, missingPaths, ready: missingPaths.length === 0 };
}
