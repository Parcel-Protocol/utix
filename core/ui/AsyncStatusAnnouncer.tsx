import type { ReactNode } from "react";

export interface AsyncStatusAnnouncerProps {
  message: string | null;
  politeness?: "polite" | "assertive";
  children?: ReactNode;
}

export function AsyncStatusAnnouncer({
  message,
  politeness = "polite",
  children
}: AsyncStatusAnnouncerProps) {
  return (
    <>
      <div
        role="status"
        aria-live={politeness}
        aria-atomic="true"
        className="sr-only"
      >
        {message}
      </div>
      {children}
    </>
  );
}
