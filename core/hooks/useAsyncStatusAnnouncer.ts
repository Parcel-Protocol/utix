import { useState, useCallback, useRef } from "react";

export type AsyncStatus = "idle" | "loading" | "success" | "error";

export interface AsyncStatusEvent {
  status: AsyncStatus;
  message?: string;
  error?: string;
}

export interface UseAsyncStatusAnnouncerOptions {
  loadingMessage?: string;
  successMessage?: string;
  errorMessagePrefix?: string;
  clearDelayMs?: number;
}

export function useAsyncStatusAnnouncer(options: UseAsyncStatusAnnouncerOptions = {}) {
  const {
    loadingMessage = "Loading...",
    successMessage = "Success",
    errorMessagePrefix = "Error: ",
    clearDelayMs = 5000
  } = options;

  const [announcement, setAnnouncement] = useState<{
    message: string;
    politeness: "polite" | "assertive";
  } | null>(null);

  const timeoutRef = useRef<NodeJS.Timeout>();

  const announce = useCallback((event: AsyncStatusEvent) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    switch (event.status) {
      case "idle":
        setAnnouncement(null);
        break;
      case "loading":
        setAnnouncement({
          message: event.message ?? loadingMessage,
          politeness: "polite"
        });
        break;
      case "success":
        setAnnouncement({
          message: event.message ?? successMessage,
          politeness: "polite"
        });
        timeoutRef.current = setTimeout(() => {
          setAnnouncement(null);
        }, clearDelayMs);
        break;
      case "error":
        setAnnouncement({
          message: `${errorMessagePrefix}${event.error ?? "Unknown error"}`,
          politeness: "assertive"
        });
        timeoutRef.current = setTimeout(() => {
          setAnnouncement(null);
        }, clearDelayMs);
        break;
    }
  }, [loadingMessage, successMessage, errorMessagePrefix, clearDelayMs]);

  return { announcement, announce };
}
