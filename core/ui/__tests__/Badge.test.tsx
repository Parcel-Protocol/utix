import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "@/core/ui/Badge";

describe("Badge", () => {
  it("communicates status with text and an icon", () => {
    render(<Badge tone="danger">Invalid</Badge>);

    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText("Invalid").parentElement?.querySelector("svg")).toBeTruthy();
  });
});