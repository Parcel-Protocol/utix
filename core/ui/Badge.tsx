import type { HTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/core/lib/cn";

type BadgeTone = "success" | "info" | "warning" | "danger" | "muted";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  success: "border-[#70c7a7]/70 bg-[#dff8ee] text-[#17664b]",
  info: "border-[#82cbe3]/70 bg-[#e0f6ff] text-[#146783]",
  warning: "border-[#ffc3a8]/80 bg-[#fff0e8] text-[#9a513f]",
  danger: "border-[#ff9a8b]/75 bg-[#fff0ee] text-[#9f342d]",
  muted: "border-[#c7b9f3]/70 bg-[#f1edff] text-[#5b4b8a]"
};

const icons = {
  success: CheckCircle2,
  info: Info,
  warning: TriangleAlert,
  danger: AlertCircle,
  muted: Info
} as const;

export function Badge({ className, tone = "muted", ...props }: BadgeProps) {
  const Icon = icons[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-wide",
        tones[tone],
        className
      )}
      {...props}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {props.children}
    </span>
  );
}
