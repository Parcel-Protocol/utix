import { describe, expect, it } from "vitest";
import { NotificationStore } from "@/core/notifications/store";
import type { NotificationStorage } from "@/core/notifications/types";

class TestStorage implements NotificationStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const account = `account:${`G${"A".repeat(55)}`}` as const;
const otherAccount = `account:${`G${"B".repeat(55)}`}` as const;

describe("NotificationStore", () => {
  it("persists notifications per recipient and deduplicates events", () => {
    const storage = new TestStorage();
    const first = new NotificationStore(storage);
    const input = {
      recipient: account,
      event: "completed" as const,
      tone: "success" as const,
      title: "Loaded",
      message: "History is ready",
      href: "/tools/operation-browser?account=GAA",
      dedupeKey: "history:1"
    };

    const created = first.publish(input);
    const duplicate = first.publish(input);

    expect(created).not.toBeNull();
    expect(duplicate?.id).toBe(created?.id);
    expect(new NotificationStore(storage).list(account)).toHaveLength(1);
    expect(new NotificationStore(storage).list(otherAccount)).toHaveLength(0);
  });

  it("tracks read state and unread count", () => {
    const store = new NotificationStore(new TestStorage());
    const created = store.publish({
      recipient: account,
      event: "failure",
      tone: "error",
      title: "Needs attention",
      message: "Try again",
      href: "/tools/operation-browser",
      dedupeKey: "failure:1"
    });

    expect(created).not.toBeNull();
    expect(store.unreadCount(account)).toBe(1);
    expect(store.markRead(account, created!.id)?.read).toBe(true);
    expect(store.unreadCount(account)).toBe(0);
    store.markAllRead(otherAccount);
    expect(store.list(otherAccount)).toEqual([]);
  });

  it("redacts secrets and rejects unsafe deep links", () => {
    const store = new NotificationStore(new TestStorage());
    const secret = `S${"A".repeat(55)}`;
    const notification = store.publish({
      recipient: account,
      event: "failure",
      tone: "error",
      title: `Failure ${secret}`,
      message: `Do not expose ${secret}`,
      href: `/tools/operation-browser?note=${secret}`,
      dedupeKey: `failure:${secret}`
    });
    const unsafe = store.publish({
      recipient: account,
      event: "completed",
      tone: "success",
      title: "Unsafe",
      message: "Unsafe",
      href: "https://example.com",
      dedupeKey: "unsafe"
    });

    expect(notification?.title).not.toContain(secret);
    expect(notification?.message).not.toContain(secret);
    expect(notification?.href).toContain("[REDACTED]");
    expect(unsafe).toBeNull();
  });

  it("keeps the newest bounded history", () => {
    const store = new NotificationStore(new TestStorage(), 2);
    for (let index = 0; index < 3; index += 1) {
      store.publish({
        recipient: account,
        event: "completed",
        tone: "success",
        title: `Loaded ${index}`,
        message: "Done",
        href: "/tools/operation-browser",
        dedupeKey: `event:${index}`,
        occurredAt: index
      });
    }

    expect(store.list(account).map((notification) => notification.dedupeKey)).toEqual(["event:2", "event:1"]);
  });
});
