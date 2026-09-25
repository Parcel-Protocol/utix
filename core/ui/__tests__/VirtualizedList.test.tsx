import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VirtualizedList } from "@/core/ui/VirtualizedList";

describe("VirtualizedList", () => {
  it("keeps the rendered row count bounded for large datasets", () => {
    const items = Array.from({ length: 500 }, (_, index) => index);

    render(
      <VirtualizedList
        items={items}
        label="Large result set"
        getKey={(item) => String(item)}
        renderItem={(item) => <span>{item}</span>}
      />
    );

    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "500");
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(screen.queryByText("499")).not.toBeInTheDocument();
  });
});