import { expect, test, type Page } from "@playwright/test";
import {
  accountId,
  operationsCollection,
  pageOneCursor,
  pageOneRecords,
  pageTwoRecords,
  unknownAccountId
} from "../../features/operation-browser/fixtures/operationBrowser.fixture";

const OPERATIONS_PATH = `/accounts/${accountId}/operations`;

const resultHeading = (page: Page) => page.getByRole("heading", { name: "Operation history", exact: true });

const workflowAlert = (page: Page, text: string) => page.getByRole("alert").filter({ hasText: text });

type FailureMode = "success" | "missing" | "rate-limited" | "transport" | "retry";

interface MockedRequests {
  paths: string[];
  attempts: () => number;
}

async function mockOperations(page: Page, mode: FailureMode = "success"): Promise<MockedRequests> {
  const paths: string[] = [];
  let attempts = 0;

  await page.route("**/accounts/**/operations**", async (route) => {
    const url = new URL(route.request().url());
    paths.push(`${url.pathname}${url.search}`);
    attempts += 1;

    if (url.pathname === `/accounts/${unknownAccountId}/operations` || mode === "missing") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ title: "Resource Missing", status: 404 })
      });
      return;
    }

    if (mode === "success") {
      const records = url.searchParams.get("cursor") === pageOneCursor ? pageTwoRecords : pageOneRecords;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(operationsCollection(records))
      });
      return;
    }

    if (mode === "rate-limited") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ title: "Rate Limit Exceeded", status: 429 })
      });
      return;
    }

    if (mode === "transport") {
      await route.abort("failed");
      return;
    }

    if (mode === "retry" && attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ title: "Service Unavailable", status: 503 })
      });
      return;
    }

    const records = url.searchParams.get("cursor") === pageOneCursor ? pageTwoRecords : pageOneRecords;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(operationsCollection(records))
    });
  });

  return { paths, attempts: () => attempts };
}

test.describe("critical account history journey", () => {
  test("loads history and follows a deterministic cursor to an older page", async ({ page }) => {
    const mocked = await mockOperations(page, "success");

    await page.goto("/tools/operation-browser");
    await page.getByLabel("Account address").fill(accountId);
    await page.getByRole("button", { name: "Browse operations" }).click();

    await expect(resultHeading(page)).toBeVisible();
    await expect(page.getByText("20 loaded operations")).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled();

    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(page.getByText("Failed in transaction")).toBeVisible();
    expect(mocked.paths[0]).toContain(OPERATIONS_PATH);
    expect(mocked.paths[1]).toContain(`cursor=${pageOneCursor}`);
  });

  test("rejects invalid input before contacting Horizon", async ({ page }) => {
    const mocked = await mockOperations(page, "retry");

    await page.goto("/tools/operation-browser");
    await page.getByRole("button", { name: "Browse operations" }).click();

    await expect(workflowAlert(page, "Enter an account address")).toBeVisible();
    expect(mocked.attempts()).toBe(0);
  });

  test("explains a missing account and keeps the workflow recoverable", async ({ page }) => {
    await mockOperations(page, "missing");

    await page.goto("/tools/operation-browser");
    await page.getByLabel("Account address").fill(unknownAccountId);
    await page.getByRole("button", { name: "Browse operations" }).click();

    await expect(workflowAlert(page, "does not exist")).toBeVisible();
  });

  test("surfaces rate limiting without exposing a raw transport error", async ({ page }) => {
    await mockOperations(page, "rate-limited");

    await page.goto("/tools/operation-browser");
    await page.getByLabel("Account address").fill(accountId);
    await page.getByRole("button", { name: "Browse operations" }).click();

    await expect(workflowAlert(page, "rate limiting")).toBeVisible();
    await expect(page.getByText("503")).toHaveCount(0);
  });

  test("recovers when a transient transport failure is retried", async ({ page }) => {
    const mocked = await mockOperations(page, "retry");

    await page.goto("/tools/operation-browser");
    await page.getByLabel("Account address").fill(accountId);
    await page.getByRole("button", { name: "Browse operations" }).click();

    await expect(workflowAlert(page, "Could not reach Horizon")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(resultHeading(page)).toBeVisible();
    expect(mocked.attempts()).toBe(2);
  });
});
