import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export const VisuallyHidden = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { children: ReactNode }>(function VisuallyHidden({ children, className, ...props }, ref) {
  return <span {...props} ref={ref} className={[styles.visuallyHidden, className].filter(Boolean).join(" ")}>{children}</span>;
});
