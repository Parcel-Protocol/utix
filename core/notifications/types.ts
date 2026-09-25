export const NOTIFICATION_EVENTS = [
  "failure",
  "approval_required",
  "completed",
  "recovery",
  "retry"
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationEvent = NotificationEventType;
export type NotificationRecipient = `account:${string}` | "workspace";
export type NotificationTone = "error" | "warning" | "success" | "info";

export interface NotificationInput {
  recipient: NotificationRecipient;
  event: NotificationEventType;
  tone: NotificationTone;
  title: string;
  message: string;
  href: string;
  dedupeKey: string;
  occurredAt?: number;
}

export interface Notification extends NotificationInput {
  id: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
