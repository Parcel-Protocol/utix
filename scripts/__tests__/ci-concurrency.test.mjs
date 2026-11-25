import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

describe("CI concurrency configuration", () => {
  test("uses a deterministic workflow + PR/ref group", () => {
    const concurrency = workflow.match(/^concurrency:\n([\s\S]*?)(?=^jobs:)/m);
    assert.ok(concurrency, "workflow-level concurrency block must exist before jobs");
    const block = concurrency[1];
    assert.match(
      block,
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/
    );
    assert.match(block, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  test("keeps push/release runs out of the cancellation path", () => {
    assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
    assert.doesNotMatch(workflow, /cancel-in-progress:\s*false/);
    assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  });

  test("does not add job-level concurrency that would override the workflow group", () => {
    const jobs = workflow.slice(workflow.indexOf("jobs:"));
    assert.doesNotMatch(jobs, /^\s+concurrency:/m);
  });

  test("preserves required step names and their order", () => {
    const expected = [
      "Checkout",
      "Setup Node",
      "Install dependencies",
      "Generate feature registry",
      "Assert generated registry has no uncommitted changes",
      "Verify the feature contract",
      "Enforce feature-slice import boundaries",
      "Verify the independent issue backlog",
      "Lint",
      "Test with coverage",
      "Publish coverage summary",
      "Build",
      "Check bundle budgets",
      "Validate disaster recovery",
      "Check operational health",
      "Install Playwright browser",
      "End-to-end test"
    ];
    const found = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(found, expected);
  });

  test("has no tabs and keeps top-level keys at column zero", () => {
    assert.doesNotMatch(workflow, /\t/);
    for (const key of ["name:", "on:", "concurrency:", "jobs:"]) {
      assert.match(workflow, new RegExp(`^${key.replace(":", "\\:")}`, "m"), `${key} must be top-level`);
    }
  });
});
