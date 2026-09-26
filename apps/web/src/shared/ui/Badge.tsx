import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export type BadgeStatus = "neutral" | "info" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
  children: ReactNode;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { status = "neutral", className, children, ...props },
  ref,
) {
  const statusClass = styles[`badge${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof styles];
  return <span {...props} ref={ref} className={[styles.badge, statusClass, className].filter(Boolean).join(" ")}>{children}</span>;
});
