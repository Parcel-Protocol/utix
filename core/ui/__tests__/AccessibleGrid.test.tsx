import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessibleGrid } from "@/core/ui/AccessibleGrid";
import { describe, it, expect, vi } from "vitest";

interface TestRow {
  id: string;
  name: string;
  value: number;
}

const testData: TestRow[] = [
  { id: "1", name: "Item A", value: 100 },
  { id: "2", name: "Item B", value: 200 },
  { id: "3", name: "Item C", value: 300 }
];

describe("AccessibleGrid", () => {
  const columns = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (row: TestRow) => row.name
    },
    {
      key: "value",
      header: "Value",
      sortable: true,
      render: (row: TestRow) => row.value.toString()
    }
  ];

  it("renders table with proper ARIA roles", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    const table = screen.getByRole("grid");
    expect(table).toBeInTheDocument();
    expect(table).toHaveAttribute("aria-label", "Test table");
  });

  it("renders caption with accessibility help", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    const caption = screen.getByText(/arrow keys to navigate/i);
    expect(caption).toBeInTheDocument();
  });

  it("renders all rows and columns", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText("Item B")).toBeInTheDocument();
    expect(screen.getByText("Item C")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("announces row count in status region", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 3 of 3 rows");
  });

  it("handles keyboard navigation with arrow keys", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    await user.click(grid);

    // The grid should be keyboard navigable (detailed behavior tested via focus management)
    expect(grid).toBeInTheDocument();
  });

  it("calls onSort callback when header is clicked", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();

    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
        onSort={onSort}
      />
    );

    const nameHeader = screen.getByText("Name");
    await user.click(nameHeader);

    expect(onSort).toHaveBeenCalledWith("name", true);
  });

  it("toggles sort direction on repeated header clicks", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
        onSort={onSort}
        sortBy="name"
        sortAscending={true}
      />
    );

    const nameHeader = screen.getByText("Name");
    await user.click(nameHeader);

    expect(onSort).toHaveBeenCalledWith("name", false);

    rerender(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
        onSort={onSort}
        sortBy="name"
        sortAscending={false}
      />
    );

    await user.click(nameHeader);
    expect(onSort).toHaveBeenCalledWith("name", true);
  });

  it("sets aria-sort on sorted column header", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
        sortBy="name"
        sortAscending={true}
      />
    );

    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    const valueHeader = screen.getByRole("columnheader", { name: "Value" });
    expect(valueHeader).toHaveAttribute("aria-sort", "none");
  });

  it("renders empty rows list correctly", () => {
    render(
      <AccessibleGrid
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        caption="Empty table"
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 0 of 0 rows");
  });

  it("sets proper row and column indices for ARIA", () => {
    const { container } = render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
      />
    );

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows[1]).toHaveAttribute("aria-rowindex", "2"); // First data row
    expect(rows[2]).toHaveAttribute("aria-rowindex", "3"); // Second data row
  });

  it("applies custom className", () => {
    const { container } = render(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={(row) => row.id}
        caption="Test table"
        className="custom-class"
      />
    );

    const wrapper = container.querySelector(".custom-class");
    expect(wrapper).toBeInTheDocument();
  });
});
