import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationCenter } from "@/core/notifications/NotificationCenter";
import { NotificationProvider } from "@/core/notifications/NotificationProvider";
import { NotificationStore } from "@/core/notifications/store";

function renderCenter(store: NotificationStore) {
  return render(
    <NotificationProvider store={store} initialRecipient="workspace">
      <NotificationCenter />
    </NotificationProvider>
  );
}

describe("NotificationCenter", () => {
  it("shows unread notifications and marks them read", async () => {
    const store = new NotificationStore();
    const user = userEvent.setup();
    store.publish({
      recipient: "workspace",
      event: "failure",
      tone: "error",
      title: "History unavailable",
      message: "Try again",
      href: "/tools/operation-browser",
      dedupeKey: "history-failure"
    });
    renderCenter(store);

    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    expect(screen.getByText("History unavailable")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mark read" }));
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(store.unreadCount("workspace")).toBe(0);
  });

  it("clears the active recipient history", async () => {
    const store = new NotificationStore();
    const user = userEvent.setup();
    store.publish({
      recipient: "workspace",
      event: "completed",
      tone: "success",
      title: "History loaded",
      message: "Done",
      href: "/tools/operation-browser",
      dedupeKey: "history-completed"
    });
    renderCenter(store);

    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(screen.getByRole("button", { name: "Clear notifications" }));
    expect(screen.getByText("No notifications for this account yet.")).toBeInTheDocument();
    expect(store.list("workspace")).toEqual([]);
  });
});
