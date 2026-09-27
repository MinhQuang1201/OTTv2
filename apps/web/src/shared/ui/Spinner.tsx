import { forwardRef, type HTMLAttributes } from "react";
import styles from "./ui.module.css";
import { VisuallyHidden } from "./VisuallyHidden";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner({ label = "Loading", className, ...props }, ref) {
  return (
    <span {...props} ref={ref} role="status" aria-label={label} className={[styles.spinner, className].filter(Boolean).join(" ")}>
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
});
