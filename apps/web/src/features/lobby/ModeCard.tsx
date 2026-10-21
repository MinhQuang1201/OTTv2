import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "../../shared/ui/Button";
import { Badge, type BadgeStatus } from "../../shared/ui/Badge";
import styles from "./lobby.module.css";

export interface ModeCardProps {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly status?: string;
  readonly statusTone?: BadgeStatus;
  readonly variant?: ButtonVariant;
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
}

export function ModeCard({
  title,
  description,
  actionLabel,
  onSelect,
  disabled = false,
  status,
  statusTone = "neutral",
  variant = "secondary",
  icon,
  children,
}: ModeCardProps) {
  return (
    <article className={styles.modeCard}>
      {icon ? <div className={styles.modeCardIcon} aria-hidden="true">{icon}</div> : null}
      <div className={styles.modeCardCopy}>
        <h3>{title}</h3>
        <p>{description}</p>
        {status ? <Badge status={statusTone}>{status}</Badge> : null}
        {children}
      </div>
      <Button variant={variant} disabled={disabled} onClick={onSelect}>
        {actionLabel}
      </Button>
    </article>
  );
}
