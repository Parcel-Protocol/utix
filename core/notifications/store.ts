import {
  NOTIFICATION_EVENTS,
  type Notification,
  type NotificationEventType,
  type NotificationInput,
  type NotificationRecipient,
  type NotificationStorage,
  type NotificationTone
} from "@/core/notifications/types";

const STORAGE_PREFIX = "utix:notifications:v1:";
const PUBLIC_ACCOUNT = /^account:G[A-Z2-7]{55}$/;
const SECRET = /\bS[A-Z2-7]{55}\b/g;

class MemoryStorage implements NotificationStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserStorage(): NotificationStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
  return new MemoryStorage();
}

function isNotificationEvent(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

function isNotificationTone(value: unknown): value is NotificationTone {
  return value === "error" || value === "warning" || value === "success" || value === "info";
}

function isNotificationRecipient(value: unknown): value is NotificationRecipient {
  return value === "workspace" || (typeof value === "string" && PUBLIC_ACCOUNT.test(value));
}

function isSafeHref(value: string): boolean {
  return /^\/(?!\/)\S*$/.test(value) && !value.toLowerCase().includes("javascript:");
}

function containsSecret(value: string): boolean {
  return value.replace(SECRET, "") !== value;
}

function scrub(value: string, maxLength: number): string {
  return value.replace(SECRET, "[REDACTED]").slice(0, maxLength);
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return `notification-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Notification>;
  return (
    typeof item.id === "string" &&
    typeof item.recipient === "string" &&
    isNotificationRecipient(item.recipient) &&
    isNotificationEvent(item.event) &&
    isNotificationTone(item.tone) &&
    typeof item.title === "string" &&
    typeof item.message === "string" &&
    typeof item.href === "string" &&
    !containsSecret(item.title) &&
    !containsSecret(item.message) &&
    !containsSecret(item.href) &&
    isSafeHref(item.href) &&
    typeof item.dedupeKey === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.read === "boolean"
  );
}

export class NotificationStore {
  private readonly storage: NotificationStorage;
  private readonly maxEntries: number;

  constructor(storage: NotificationStorage = browserStorage(), maxEntries = 50) {
    this.storage = storage;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  private key(recipient: NotificationRecipient): string {
    return `${STORAGE_PREFIX}${recipient}`;
  }

  private read(recipient: NotificationRecipient): Notification[] {
    const raw = this.storage.getItem(this.key(recipient));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isNotification).filter((item) => item.recipient === recipient);
    } catch {
      return [];
    }
  }

  private write(recipient: NotificationRecipient, notifications: Notification[]): void {
    this.storage.setItem(this.key(recipient), JSON.stringify(notifications.slice(0, this.maxEntries)));
  }

  list(recipient: NotificationRecipient): Notification[] {
    if (!isNotificationRecipient(recipient)) return [];
    return this.read(recipient).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  unreadCount(recipient: NotificationRecipient): number {
    return this.list(recipient).filter((notification) => !notification.read).length;
  }

  publish(input: NotificationInput): Notification | null {
    if (
      !isNotificationRecipient(input.recipient) ||
      !isNotificationEvent(input.event) ||
      !isNotificationTone(input.tone) ||
      typeof input.title !== "string" ||
      typeof input.message !== "string" ||
      typeof input.href !== "string" ||
      typeof input.dedupeKey !== "string" ||
      !isSafeHref(input.href) ||
      !input.dedupeKey.trim()
    ) {
      return null;
    }

    const dedupeKey = scrub(input.dedupeKey, 160);
    const existing = this.read(input.recipient);
    const duplicate = existing.find(
      (notification) => notification.event === input.event && notification.dedupeKey === dedupeKey
    );
    if (duplicate) return duplicate;

    const timestamp = input.occurredAt ?? Date.now();
    const createdAt = new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
    const href = scrub(input.href, 1000);
    const notification: Notification = {
      id: stableId(`${input.recipient}|${input.event}|${dedupeKey}`),
      recipient: input.recipient,
      event: input.event,
      tone: input.tone,
      title: scrub(input.title, 120),
      message: scrub(input.message, 500),
      href,
      dedupeKey,
      createdAt,
      read: false
    };

    this.write(input.recipient, [notification, ...existing]);
    return notification;
  }

  markRead(recipient: NotificationRecipient, id: string): Notification | null {
    if (!isNotificationRecipient(recipient)) return null;
    const notifications = this.read(recipient);
    const index = notifications.findIndex((notification) => notification.id === id);
    if (index < 0) return null;
    const notification = { ...notifications[index], read: true };
    notifications[index] = notification;
    this.write(recipient, notifications);
    return notification;
  }

  markAllRead(recipient: NotificationRecipient): Notification[] {
    if (!isNotificationRecipient(recipient)) return [];
    const notifications = this.read(recipient).map((notification) => ({ ...notification, read: true }));
    this.write(recipient, notifications);
    return notifications;
  }

  clear(recipient: NotificationRecipient): void {
    if (isNotificationRecipient(recipient)) this.storage.removeItem(this.key(recipient));
  }
}
