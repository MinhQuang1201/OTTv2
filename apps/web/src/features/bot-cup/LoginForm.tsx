import { useState, type FormEvent } from "react";
import { Button } from "../../shared/ui/Button";
import { TextField } from "../../shared/ui/TextField";
import { BotCupApiError, type BotCupApiGateway, type BotCupEvent, type TeamView } from "./BotCupApiGateway";
import { botCupErrorMessage } from "./botCupMessages";
import { FormAlert, MSSV_PATTERN, useTurnstileToken } from "./formParts";
import { OtpStep } from "./RegisterFlow";
import { TurnstileWidget } from "./TurnstileWidget";
import styles from "./botCup.module.css";

export interface LoginFormProps {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly onSignedIn: (team: TeamView) => void;
}

type Mode = { readonly kind: "login" } | { readonly kind: "verify"; readonly handle: string } | { readonly kind: "reset" };

export function LoginForm({ gateway, event, onSignedIn }: LoginFormProps) {
  const [mode, setMode] = useState<Mode>({ kind: "login" });
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstile = useTurnstileToken();

  if (mode.kind === "verify") {
    return <OtpStep gateway={gateway} event={event} handle={mode.handle} sentTo={null} onVerified={onSignedIn} />;
  }
  if (mode.kind === "reset") {
    return (
      <PasswordReset gateway={gateway} event={event} initialHandle={handle}
        onDone={(message) => { setMode({ kind: "login" }); setPassword(""); setAlert({ message, tone: "success" }); }}
        onCancel={() => setMode({ kind: "login" })} />
    );
  }

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setAlert(null);
    const normalized = handle.trim().toLowerCase();
    if (!normalized || !password) {
      setAlert({ message: "Nhập tên đăng nhập và mật khẩu.", tone: "error" });
      return;
    }
    if (!turnstile.token) {
      setAlert({ message: "Hãy hoàn tất bước xác minh bạn không phải máy.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      onSignedIn(await gateway.login(normalized, password, turnstile.token));
    } catch (error) {
      if (error instanceof BotCupApiError && error.code === "verification_required") {
        setMode({ kind: "verify", handle: normalized });
        return;
      }
      setAlert({ message: botCupErrorMessage(error), tone: "error" });
    } finally {
      turnstile.consume();
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="bot-cup-login-title">
      <h2 id="bot-cup-login-title">Đăng nhập đội</h2>
      <TextField label="Tên đăng nhập" value={handle} onChange={(e) => setHandle(e.currentTarget.value.toLowerCase())}
        autoComplete="username" autoCapitalize="none" spellCheck={false} />
      <TextField label="Mật khẩu" type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
      <TurnstileWidget siteKey={event.turnstileSiteKey} onToken={turnstile.setToken} resetKey={turnstile.resetKey} />
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</Button>
        <Button type="button" variant="quiet" onClick={() => { setAlert(null); setMode({ kind: "reset" }); }}>Quên mật khẩu?</Button>
      </div>
    </form>
  );
}

function PasswordReset({ gateway, event, initialHandle, onDone, onCancel }: {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly initialHandle: string;
  readonly onDone: (message: string) => void;
  readonly onCancel: () => void;
}) {
  const [handle, setHandle] = useState(initialHandle);
  const [mssv, setMssv] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstile = useTurnstileToken();

  const request = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setAlert(null);
    if (!handle.trim()) return setAlert("Nhập tên đăng nhập của đội.");
    if (mssv && !MSSV_PATTERN.test(mssv)) return setAlert("MSSV phải gồm đúng 8 chữ số.");
    if (!turnstile.token) return setAlert("Hãy hoàn tất bước xác minh bạn không phải máy.");
    setBusy(true);
    try {
      const result = await gateway.requestPasswordReset(handle.trim().toLowerCase(), turnstile.token, mssv || undefined);
      setSentTo(result.otpSentTo);
    } catch (error) {
      setAlert(botCupErrorMessage(error));
    } finally {
      turnstile.consume();
      setBusy(false);
    }
  };

  const confirmReset = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setAlert(null);
    if (!/^\d{6}$/.test(code)) return setAlert("Mã gồm 6 chữ số.");
    if (password.length < 10) return setAlert("Mật khẩu mới cần ít nhất 10 ký tự.");
    if (password !== confirm) return setAlert("Mật khẩu nhập lại không khớp.");
    setBusy(true);
    try {
      await gateway.confirmPasswordReset(handle.trim().toLowerCase(), code, password);
      onDone("Đã đặt lại mật khẩu. Mọi thiết bị đã bị đăng xuất; hãy đăng nhập bằng mật khẩu mới.");
    } catch (error) {
      setAlert(botCupErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <form className={styles.form} onSubmit={confirmReset} noValidate aria-labelledby="bot-cup-reset-title">
        <h2 id="bot-cup-reset-title">Đặt mật khẩu mới</h2>
        <p>Mã 6 chữ số đã gửi tới <strong>{sentTo}</strong> (hiệu lực 10 phút).</p>
        <TextField label="Mã xác minh" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))} />
        <TextField label="Mật khẩu mới" type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" />
        <TextField label="Nhập lại mật khẩu mới" type="password" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="new-password" />
        <FormAlert message={alert} />
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}>Đặt lại mật khẩu</Button>
          <Button type="button" variant="quiet" onClick={onCancel}>Huỷ</Button>
        </div>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={request} noValidate aria-labelledby="bot-cup-reset-title">
      <h2 id="bot-cup-reset-title">Quên mật khẩu</h2>
      <p>Mã đặt lại gửi tới email của đội trưởng, hoặc của thành viên đã xác nhận nếu bạn nhập MSSV của mình.</p>
      <TextField label="Tên đăng nhập của đội" value={handle} onChange={(e) => setHandle(e.currentTarget.value.toLowerCase())} autoCapitalize="none" spellCheck={false} />
      <TextField label="MSSV của bạn (không bắt buộc)" value={mssv} inputMode="numeric" maxLength={8} onChange={(e) => setMssv(e.currentTarget.value.replace(/\D/g, ""))} />
      <TurnstileWidget siteKey={event.turnstileSiteKey} onToken={turnstile.setToken} resetKey={turnstile.resetKey} />
      <FormAlert message={alert} />
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>Gửi mã</Button>
        <Button type="button" variant="quiet" onClick={onCancel}>Quay lại đăng nhập</Button>
      </div>
    </form>
  );
}
