import { describe, expect, it } from "vitest";
import {
  getStatusAnnouncement,
  getStatusAriaAttributes,
  getStatusLivePoliteness,
  type AsyncStatus
} from "@/core/ui/accessibility";
import {
  A11Y_PATHS,
  evaluateKeyboardAsyncCoverage,
  type A11yPath,
  type A11yCoverageInput,
  type AsyncStatusObservation,
  type KeyboardObservation
} from "../keyboard-async-coverage";

const SUCCESS = "Changes saved";
const FAILURE = "Could not save changes";

function keyboard(path: A11yPath): KeyboardObservation {
  return {
    path,
    focusOrder: ["open", "confirm", "cancel"],
    expectedFocusOrder: ["open", "confirm", "cancel"],
    activatedControlId: "confirm",
    expectedActivationId: "confirm",
    focusReturnedToId: "open",
    expectedFocusReturnId: "open"
  };
}

function status(path: A11yPath, value: AsyncStatus): AsyncStatusObservation {
  const attributes = getStatusAriaAttributes(value);
  return {
    path,
    status: value,
    announcement: getStatusAnnouncement(value, SUCCESS, FAILURE),
    politeness: getStatusLivePoliteness(value),
    role: attributes.role,
    busy: attributes["aria-busy"],
    successMessage: SUCCESS,
    errorMessage: FAILURE
  };
}

function completeInput(): A11yCoverageInput {
  return {
    keyboard: A11Y_PATHS.map(keyboard),
    asyncStatus: [
      status("normal", "success"),
      status("failure", "error"),
      status("retry", "loading"),
      status("retry", "error"),
      status("retry", "success"),
      status("authorization", "error")
    ]
  };
}

describe("Keyboard and async status accessibility coverage (#459)", () => {
  it("normal path: all four paths pass when the shipped helper contracts are met", () => {
    const report = evaluateKeyboardAsyncCoverage(completeInput());

    expect(report.ready).toBe(true);
    expect(report.missingPaths).toEqual([]);
    expect(report.paths).toHaveLength(4);
    expect(report.paths.every((item) => item.passed && item.issues.length === 0)).toBe(true);
  });

  it("failure path: a wrong announcement and role are reported", () => {
    const input = completeInput();
    input.asyncStatus = input.asyncStatus.map((item) =>
      item.path === "failure" ? { ...item, announcement: "silent", role: "status" } : item
    );

    const report = evaluateKeyboardAsyncCoverage(input);
    const failure = report.paths.find((item) => item.path === "failure");

    expect(report.ready).toBe(false);
    expect(report.missingPaths).toContain("failure");
    expect(failure?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["async_announcement", "async_role"])
    );
  });

  it("retry path: every step of loading → error → success is required", () => {
    const input = completeInput();
    input.asyncStatus = input.asyncStatus.filter(
      (item) => !(item.path === "retry" && item.status === "success")
    );

    const report = evaluateKeyboardAsyncCoverage(input);
    const retry = report.paths.find((item) => item.path === "retry");

    expect(report.ready).toBe(false);
    expect(report.missingPaths).toContain("retry");
    expect(retry?.issues.map((issue) => issue.code)).toContain("async_status_sequence");
  });

  it("authorization path: missing keyboard evidence and lost focus are reported", () => {
    const input = completeInput();
    input.keyboard = input.keyboard.filter((item) => item.path !== "authorization");
    input.keyboard.push({
      ...keyboard("authorization"),
      activatedControlId: undefined,
      focusReturnedToId: "cancel"
    });

    const report = evaluateKeyboardAsyncCoverage(input);
    const authorization = report.paths.find((item) => item.path === "authorization");

    expect(report.ready).toBe(false);
    expect(report.missingPaths).toContain("authorization");
    expect(authorization?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["keyboard_activation", "keyboard_focus_return"])
    );
  });

  it("edge path: an error must be assertive and busy must match the status", () => {
    const input = completeInput();
    input.asyncStatus = input.asyncStatus.map((item) =>
      item.path === "authorization" ? { ...item, politeness: "polite", busy: true } : item
    );

    const report = evaluateKeyboardAsyncCoverage(input);
    const authorization = report.paths.find((item) => item.path === "authorization");

    expect(authorization?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["async_error_not_assertive", "async_busy"])
    );
  });
});
