import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccessibleTree, validateAccessibleTreeNodes, type AccessibleTreeNode } from "@/core/ui/AccessibleTree";
import { expectNoAxeViolations } from "@/core/testing/axe";

// Three-level nested fixture: two roots, one branch with a nested branch.
const nestedFixture: AccessibleTreeNode[] = [
  {
    id: "tree-root-a",
    label: "Root A",
    children: [
      { id: "tree-a-child-1", label: "Child A1", value: "a1" },
      {
        id: "tree-a-child-2",
        label: "Child A2",
        children: [
          { id: "tree-a-grandchild-1", label: "Grandchild A2a", value: "a2a" },
          { id: "tree-a-grandchild-2", label: "Grandchild A2b" }
        ]
      }
    ]
  },
  { id: "tree-root-b", label: "Root B", value: "b" }
];

function item(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Expected treeitem #${id} to be rendered`);
  return element;
}

function buildDeepChain(depth: number): AccessibleTreeNode[] {
  let leaf: AccessibleTreeNode = { id: "tree-deep-leaf", label: "Leaf" };
  for (let level = depth; level > 0; level -= 1) {
    leaf = { id: `tree-deep-${level}`, label: `Level ${level}`, children: [leaf] };
  }
  return [leaf];
}

describe("AccessibleTree", () => {
  it("renders a tree with its accessible name", () => {
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    const tree = screen.getByRole("tree", { name: "Fixture tree" });
    expect(tree).toBeInTheDocument();
  });

  it("exposes every node as a treeitem with level, setsize and posinset", () => {
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    expect(screen.getAllByRole("treeitem")).toHaveLength(6);

    const rootA = item("tree-root-a");
    expect(rootA).toHaveAttribute("aria-level", "1");
    expect(rootA).toHaveAttribute("aria-setsize", "2");
    expect(rootA).toHaveAttribute("aria-posinset", "1");

    const childA2 = item("tree-a-child-2");
    expect(childA2).toHaveAttribute("aria-level", "2");
    expect(childA2).toHaveAttribute("aria-setsize", "2");
    expect(childA2).toHaveAttribute("aria-posinset", "2");

    const grandchild = item("tree-a-grandchild-1");
    expect(grandchild).toHaveAttribute("aria-level", "3");
    expect(grandchild).toHaveAttribute("aria-setsize", "2");
    expect(grandchild).toHaveAttribute("aria-posinset", "1");
  });

  it("marks branches expanded and leaves without aria-expanded", () => {
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "true");
    expect(item("tree-a-child-2")).toHaveAttribute("aria-expanded", "true");
    expect(item("tree-root-b")).not.toHaveAttribute("aria-expanded");
    expect(item("tree-a-child-1")).not.toHaveAttribute("aria-expanded");
  });

  it("groups each branch's children in a group container", () => {
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    const groups = screen.getAllByRole("group");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(within(groups[0]).getByText("Child A1")).toBeInTheDocument();
  });

  it("keeps exactly one treeitem in the tab order with selection following focus", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    const items = screen.getAllByRole("treeitem");
    expect(items.filter((entry) => entry.tabIndex === 0)).toHaveLength(1);
    expect(item("tree-root-a")).toHaveAttribute("tabindex", "0");
    expect(item("tree-root-a")).toHaveAttribute("aria-selected", "true");

    await user.click(item("tree-a-child-1"));

    expect(item("tree-a-child-1")).toHaveAttribute("tabindex", "0");
    expect(item("tree-a-child-1")).toHaveAttribute("aria-selected", "true");
    expect(item("tree-root-a")).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("treeitem").filter((entry) => entry.tabIndex === 0)).toHaveLength(1);
  });

  it("moves focus with ArrowDown and ArrowUp across visible nodes", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-a"));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(item("tree-a-child-1")).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(item("tree-a-child-2")).toHaveFocus());

    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(item("tree-a-child-1")).toHaveFocus());
  });

  it("moves focus with Home and End", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-a-child-1"));
    await user.keyboard("{End}");
    await waitFor(() => expect(item("tree-root-b")).toHaveFocus());

    await user.keyboard("{Home}");
    await waitFor(() => expect(item("tree-root-a")).toHaveFocus());
  });

  it("collapses an expanded branch with ArrowLeft and hides its descendants", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-a-child-2"));
    await user.keyboard("{ArrowLeft}");

    await waitFor(() => expect(item("tree-a-child-2")).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByText("Grandchild A2a")).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(4);
  });

  it("skips collapsed descendants in ArrowDown order", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-a"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "false"));

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(item("tree-root-b")).toHaveFocus());
  });

  it("expands a collapsed branch with ArrowRight and reveals its descendants", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-a"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "false"));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByText("Grandchild A2a")).toBeInTheDocument();
  });

  it("moves focus to the first child with ArrowRight on an expanded branch", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-a"));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(item("tree-a-child-1")).toHaveFocus());
  });

  it("moves focus to the parent with ArrowLeft on a collapsed child or leaf", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-a-child-1"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(item("tree-root-a")).toHaveFocus());

    await user.click(item("tree-a-grandchild-1"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(item("tree-a-child-2")).toHaveFocus());
  });

  it("toggles branch expansion with Enter and Space", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-a-child-2"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(item("tree-a-child-2")).toHaveAttribute("aria-expanded", "false"));

    await user.keyboard(" ");
    await waitFor(() => expect(item("tree-a-child-2")).toHaveAttribute("aria-expanded", "true"));
  });

  it("ignores Enter on a leaf node", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-b"));
    await user.keyboard("{Enter}");

    expect(item("tree-root-b")).not.toHaveAttribute("aria-expanded");
    expect(screen.getAllByRole("treeitem")).toHaveLength(6);
  });

  it("toggles expansion through the branch disclosure button", async () => {
    const user = userEvent.setup();
    render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(screen.getByRole("button", { name: "Collapse Root A" }));
    await waitFor(() => expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getByRole("button", { name: "Expand Root A" })).toBeInTheDocument();
  });

  it("renders an empty tree without crashing", () => {
    render(<AccessibleTree label="Empty tree" nodes={[]} />);

    expect(screen.getByRole("tree", { name: "Empty tree" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails accessibly on duplicate node ids", () => {
    render(
      <AccessibleTree
        label="Broken tree"
        nodes={[
          { id: "tree-dup", label: "First" },
          { id: "tree-dup", label: "Second" }
        ]}
      />
    );

    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/tree-dup/);
  });

  it("fails accessibly on missing node ids", () => {
    render(<AccessibleTree label="Broken tree" nodes={[{ id: "", label: "Nameless" }]} />);

    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/non-empty string id/);
  });

  it("fails accessibly on non-array children", () => {
    const malformed = {
      id: "tree-bad-children",
      label: "Bad",
      children: "not-an-array"
    } as unknown as AccessibleTreeNode;
    render(<AccessibleTree label="Broken tree" nodes={[malformed]} />);

    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/must be an array/);
  });

  it("fails accessibly on excessive nesting depth", () => {
    render(<AccessibleTree label="Broken tree" nodes={buildDeepChain(40)} />);

    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/maximum depth/);
  });

  it("validates without descending into cyclic references", () => {
    const cyclic: AccessibleTreeNode = { id: "tree-cycle", label: "Cycle", children: [] };
    cyclic.children!.push(cyclic);

    const result = validateAccessibleTreeNodes([cyclic]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe("duplicate-id");
    }
  });

  it("has no axe violations in its initial expanded state", async () => {
    const { container } = render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);
    await expectNoAxeViolations(container);
  });

  it("has no axe violations with a collapsed branch", async () => {
    const user = userEvent.setup();
    const { container } = render(<AccessibleTree label="Fixture tree" nodes={nestedFixture} />);

    await user.click(item("tree-root-a"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(item("tree-root-a")).toHaveAttribute("aria-expanded", "false"));

    await expectNoAxeViolations(container);
  });
});
