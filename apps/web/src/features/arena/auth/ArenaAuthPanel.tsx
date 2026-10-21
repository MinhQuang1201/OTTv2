import { useEffect, useState, type FormEvent } from "react";
import type { ArenaRegistrationResult } from "../ArenaApiGateway";
import { Button } from "../../../shared/ui/Button";
import { TextField } from "../../../shared/ui/TextField";
import styles from "./arenaAuth.module.css";

export interface ArenaAuthPanelProps {
  readonly registrationEnabled?: boolean;
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly initialUsername?: string;
  readonly onLogin: (credentials: { username: string; password: string }) => void | Promise<void>;
  readonly onRegister: (credentials: { username: string; password: string }) => Promise<ArenaRegistrationResult>;
}

export function ArenaAuthPanel({
  registrationEnabled = false,
  pending = false,
  error,
  notice,
  initialUsername = "",
  onLogin,
  onRegister,
}: ArenaAuthPanelProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (initialUsername) {
      setUsername(initialUsername);
    }
  }, [initialUsername]);

  const changeMode = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setLocalError(null);
    setLocalNotice(null);
    setSubmitting(false);
  };

  const isPending = pending || submitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isPending) return;
    setLocalError(null);
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) return;

    if (mode === "register") {
      if (password !== confirmPassword) {
        setLocalError("Mật khẩu xác nhận không khớp.");
        return;
      }
      setSubmitting(true);
      try {
        const result = await onRegister({ username: trimmedUsername, password });
        setMode("login");
        if (result?.user?.username) {
          setUsername(result.user.username);
        }
        setLocalNotice("Tài khoản đã tạo. Hãy đăng nhập để tiếp tục.");
        setPassword("");
        setConfirmPassword("");
      } catch (err: unknown) {
        const anyErr = err as any;
        if (anyErr?.name === "AbortError" || anyErr?.code === "abort_error") {
          return;
        }
        setLocalNotice(null);
        setLocalError((err as Error)?.message || "Đăng ký thất bại.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    try {
      await onLogin({ username: trimmedUsername, password });
    } catch (err: unknown) {
      const anyErr = err as any;
      if (anyErr?.name === "AbortError" || anyErr?.code === "abort_error") {
        return;
      }
      setLocalError((err as Error)?.message || "Đăng nhập thất bại.");
    } finally {
      setSubmitting(false);
    }
  };

  const displayNotice = notice ?? localNotice;
  const displayError = localError || error;

  return (
    <div className={styles.panel}>
      <div className={styles.tabs} role="tablist" aria-label="Xác thực Arena">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          onClick={() => changeMode("login")}
        >
          Đăng nhập
        </button>
        {registrationEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => changeMode("register")}
          >
            Đăng ký
          </button>
        )}
      </div>
      {displayNotice && (
        <div className={styles.notice} role="status">
          {displayNotice}
        </div>
      )}
      {displayError && (
        <div className={styles.error} role="alert" data-testid="login-error-alert">
          {displayError}
        </div>
      )}
      <form onSubmit={submit} className={styles.form}>
        <TextField
          label="Tên đăng nhập"
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          autoComplete="username"
          disabled={isPending}
        />
        <TextField
          label="Mật khẩu"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          disabled={isPending}
        />
        {mode === "register" && (
          <TextField
            label="Xác nhận mật khẩu"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.currentTarget.value)}
            autoComplete="new-password"
            disabled={isPending}
          />
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={isPending || !username.trim() || !password}
        >
          {isPending ? "Đang xử lý..." : mode === "register" ? "Tạo tài khoản" : "Đăng nhập"}
        </Button>
      </form>
    </div>
  );
}
