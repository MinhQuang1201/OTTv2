import { useCallback, useState, type ReactNode } from "react";
import styles from "./botCup.module.css";

export function Checkbox({ checked, onChange, children, error }: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly error?: string | null;
}) {
  return (
    <div className={styles.checkField}>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} aria-invalid={error ? true : undefined} />
        <span>{children}</span>
      </label>
      {error ? <div className={styles.fieldError}>{error}</div> : null}
    </div>
  );
}

export function FormAlert({ message, tone = "error" }: { readonly message: string | null; readonly tone?: "error" | "success" | "info" }) {
  if (!message) return null;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={[styles.alert, styles[`alert_${tone}`]].join(" ")}>
      {message}
    </div>
  );
}

/** Turnstile token state: one token per request, so `consume()` clears it and asks the widget for a new one. */
export function useTurnstileToken() {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const consume = useCallback(() => {
    setResetKey((value) => value + 1);
  }, []);
  return { token, setToken, resetKey, consume };
}

/** Links to the starter kit the web build publishes at /bot-cup-kit/ (plan §6.4). */
export function StarterKitLinks() {
  const files: ReadonlyArray<readonly [string, string]> = [
    ["GUIDE.vi.md", "Hướng dẫn"],
    ["bot.py", "Bot mẫu Python"],
    ["bot.mjs", "Bot mẫu JavaScript"],
    ["judge.mjs", "Trọng tài chạy trên máy (Node 22)"],
  ];
  return (
    <ul className={styles.kitLinks} aria-label="Bộ khởi đầu">
      {files.map(([file, label]) => (
        <li key={file}><a className={styles.link} href={`/bot-cup-kit/${file}`} download={file}>{label}</a> <code>{file}</code></li>
      ))}
    </ul>
  );
}

export const MSSV_PATTERN = /^\d{8}$/;
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
