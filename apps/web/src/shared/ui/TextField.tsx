import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "children"> {
  label: ReactNode;
  id?: string;
  description?: ReactNode;
  error?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, id: suppliedId, description, error, className, ...props },
  ref,
) {
  const generatedId = useId();
  const id = suppliedId ?? `field-${generatedId.replace(/:/g, "")}`;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <input
        {...props}
        ref={ref}
        id={id}
        className={[styles.input, className].filter(Boolean).join(" ")}
        aria-describedby={describedBy}
        aria-invalid={error ? true : props["aria-invalid"]}
      />
      {description ? <div className={styles.supporting} id={descriptionId}>{description}</div> : null}
      {error ? <div className={styles.error} id={errorId}>{error}</div> : null}
    </div>
  );
});
