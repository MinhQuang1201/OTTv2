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
}

export function ModeCard({ title, description, actionLabel, onSelect, disabled = false, status, statusTone = "neutral", variant = "secondary" }: ModeCardProps) {
  return (
    <article className={styles.modeCard}>
      <div className={styles.modeCardCopy}>
        <h3>{title}</h3>
        <p>{description}</p>
        {status ? <Badge status={statusTone}>{status}</Badge> : null}
      </div>
      <Button variant={variant} disabled={disabled} onClick={onSelect}>{actionLabel}</Button>
    </article>
  );
}

