import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  heading?: ReactNode;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { heading, className, children, ...props },
  ref,
) {
  return (
    <div {...props} ref={ref} className={[styles.panel, className].filter(Boolean).join(" ")}>
      {heading ? <h2 className={styles.panelTitle}>{heading}</h2> : null}
      {children}
    </div>
  );
});
