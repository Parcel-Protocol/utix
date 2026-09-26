"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { NotificationStore } from "@/core/notifications/store";
import type {
  Notification,
  NotificationInput,
  NotificationRecipient
} from "@/core/notifications/types";

interface NotificationContextValue {
  activeRecipient: NotificationRecipient;
  notifications: Notification[];
  unreadCount: number;
  setActiveRecipient: (recipient: NotificationRecipient) => void;
  publish: (input: NotificationInput) => Notification | null;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

const defaultContext: NotificationContextValue = {
  activeRecipient: "workspace",
  notifications: [],
  unreadCount: 0,
  setActiveRecipient: () => undefined,
  publish: () => null,
  markRead: () => undefined,
  markAllRead: () => undefined,
  clear: () => undefined
};

const NotificationContext = createContext<NotificationContextValue>(defaultContext);

export function NotificationProvider({
  children,
  store: providedStore,
  initialRecipient = "workspace"
}: {
  children: ReactNode;
  store?: NotificationStore;
  initialRecipient?: NotificationRecipient;
}) {
  const [store] = useState(() => providedStore ?? new NotificationStore());
  const [activeRecipient, setActiveRecipientState] = useState<NotificationRecipient>(initialRecipient);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    queueMicrotask(() => setNotifications(store.list(activeRecipient)));
  }, [activeRecipient, store]);

  const setActiveRecipient = useCallback(
    (recipient: NotificationRecipient) => {
      setActiveRecipientState(recipient);
      setNotifications(store.list(recipient));
    },
    [store]
  );

  const publish = useCallback(
    (input: NotificationInput) => {
      const notification = store.publish(input);
      if (!notification) return null;
      setActiveRecipient(input.recipient);
      return notification;
    },
    [setActiveRecipient, store]
  );

  const markRead = useCallback(
    (id: string) => {
      store.markRead(activeRecipient, id);
      setNotifications(store.list(activeRecipient));
    },
    [activeRecipient, store]
  );

  const markAllRead = useCallback(() => {
    store.markAllRead(activeRecipient);
    setNotifications(store.list(activeRecipient));
  }, [activeRecipient, store]);

  const clear = useCallback(() => {
    store.clear(activeRecipient);
    setNotifications([]);
  }, [activeRecipient, store]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      activeRecipient,
      notifications,
      unreadCount: notifications.filter((notification) => !notification.read).length,
      setActiveRecipient,
      publish,
      markRead,
      markAllRead,
      clear
    }),
    [activeRecipient, clear, markAllRead, markRead, notifications, publish, setActiveRecipient]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext);
}
