import { useState, type FormEvent } from "react";
import { Button } from "../../shared/ui/Button";
import { TextField } from "../../shared/ui/TextField";
import type { BotCupApiGateway, BotCupEvent, TeamKind, TeamView } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage, errorField } from "./botCupMessages";
import { Checkbox, FormAlert, HANDLE_PATTERN, MSSV_PATTERN, useTurnstileToken } from "./formParts";
import { TurnstileWidget } from "./TurnstileWidget";
import styles from "./botCup.module.css";

type Fields = "displayName" | "handle" | "password" | "confirm" | "fullName" | "mssv" | "email" | "consent";
type FieldErrors = Partial<Record<Fields, string>>;

const API_FIELD: Readonly<Record<string, Fields>> = { displayName: "displayName", handle: "handle", password: "password", fullName: "fullName", mssv: "mssv", email: "email", consent: "consent" };
// Errors the API reports without a field, attached to the field they are about.
const CODE_FIELD: Readonly<Record<string, Fields>> = {
  handle_taken: "handle", handle_reserved: "handle", display_name_taken: "displayName", display_name_blocked: "displayName",
  mssv_taken: "mssv", email_taken: "email",
};

function validate(form: { displayName: string; handle: string; password: string; confirm: string; fullName: string; mssv: string; email: string; consent: boolean }, event: BotCupEvent): FieldErrors {
  const errors: FieldErrors = {};
  if (form.displayName.trim().length < 3) errors.displayName = BOT_CUP_ERROR_MESSAGES.display_name_invalid;
  if (!HANDLE_PATTERN.test(form.handle.trim().toLowerCase()) || form.handle.includes("--")) errors.handle = BOT_CUP_ERROR_MESSAGES.handle_invalid;
  if (form.password.length < 10 || form.password.length > 128) errors.password = BOT_CUP_ERROR_MESSAGES.password_weak;
  if (form.confirm !== form.password) errors.confirm = "Mật khẩu nhập lại không khớp.";
  if (form.fullName.trim().length < 2) errors.fullName = BOT_CUP_ERROR_MESSAGES.full_name_invalid;
  const mssv = form.mssv.trim();
  if (!MSSV_PATTERN.test(mssv)) errors.mssv = BOT_CUP_ERROR_MESSAGES.mssv_invalid;
  else if (event.eligibility.mssvPrefix && !mssv.startsWith(event.eligibility.mssvPrefix)) errors.mssv = BOT_CUP_ERROR_MESSAGES.mssv_not_eligible;
  if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = BOT_CUP_ERROR_MESSAGES.email_invalid;
  if (!form.consent) errors.consent = BOT_CUP_ERROR_MESSAGES.consent_required;
  return errors;
}

export interface RegisterFlowProps {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly onRegistered: (team: TeamView) => void;
  readonly onShowRules?: () => void;
}

/** Registration (plan §5): team details and captain → OTP to the captain's address → verified team and session. */
export function RegisterFlow({ gateway, event, onRegistered, onShowRules }: RegisterFlowProps) {
  const [kind, setKind] = useState<TeamKind>("solo");
  const [form, setForm] = useState({ displayName: "", handle: "", password: "", confirm: "", fullName: "", mssv: "", email: "", consent: false, showName: true });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ readonly handle: string; readonly otpSentTo: string } | null>(null);
  const turnstile = useTurnstileToken();

  if (pending) {
    return <OtpStep gateway={gateway} event={event} handle={pending.handle} sentTo={pending.otpSentTo} onVerified={onRegistered} />;
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key as Fields]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setAlert(null);
    const found = validate(form, event);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    if (!turnstile.token) {
      setAlert("Hãy hoàn tất bước xác minh bạn không phải máy.");
      return;
    }
    setBusy(true);
    try {
      const result = await gateway.register({
        kind,
        handle: form.handle.trim().toLowerCase(),
        displayName: form.displayName.trim(),
        password: form.password,
        consent: form.consent,
        showName: form.showName,
        turnstileToken: turnstile.token,
        captain: { fullName: form.fullName.trim(), mssv: form.mssv.trim(), ...(form.email.trim() ? { email: form.email.trim() } : {}) },
      });
      setPending({ handle: result.handle, otpSentTo: result.otpSentTo });
    } catch (error) {
      const field = errorField(error);
      const code = (error as { code?: string }).code ?? "";
      const target = (field && API_FIELD[field]) || CODE_FIELD[code];
      if (target) setErrors({ [target]: botCupErrorMessage(error) });
      else setAlert(botCupErrorMessage(error));
    } finally {
      turnstile.consume();
      setBusy(false);
    }
  };

  const school = event.eligibility.emailDomain;
  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="bot-cup-register-title">
      <h2 id="bot-cup-register-title">Đăng ký tham gia</h2>
      <fieldset className={styles.kindField}>
        <legend>Hình thức</legend>
        <label className={styles.radio}>
          <input type="radio" name="bot-cup-kind" checked={kind === "solo"} onChange={() => setKind("solo")} />
          <span>Cá nhân</span>
        </label>
        <label className={styles.radio}>
          <input type="radio" name="bot-cup-kind" checked={kind === "group"} onChange={() => setKind("group")} />
          <span>Nhóm 2–3 người</span>
        </label>
      </fieldset>

      <TextField label={kind === "group" ? "Tên đội" : "Tên hiển thị"} value={form.displayName} error={errors.displayName} maxLength={32}
        onChange={(e) => set("displayName", e.currentTarget.value)} autoComplete="off" />
      <TextField label="Tên đăng nhập" value={form.handle} error={errors.handle} maxLength={24}
        description="Dùng để đăng nhập; chữ thường a–z, số và dấu gạch ngang."
        onChange={(e) => set("handle", e.currentTarget.value.toLowerCase())} autoComplete="username" autoCapitalize="none" spellCheck={false} />
      <TextField label="Mật khẩu" type="password" value={form.password} error={errors.password}
        description={kind === "group" ? "Cả đội dùng chung một mật khẩu. Tối thiểu 10 ký tự." : "Tối thiểu 10 ký tự."}
        onChange={(e) => set("password", e.currentTarget.value)} autoComplete="new-password" />
      <TextField label="Nhập lại mật khẩu" type="password" value={form.confirm} error={errors.confirm}
        onChange={(e) => set("confirm", e.currentTarget.value)} autoComplete="new-password" />

      <h3 className={styles.subheading}>{kind === "group" ? "Đội trưởng" : "Thông tin của bạn"}</h3>
      <TextField label="Họ và tên" value={form.fullName} error={errors.fullName} maxLength={64}
        onChange={(e) => set("fullName", e.currentTarget.value)} autoComplete="name" />
      <TextField label="MSSV" value={form.mssv} error={errors.mssv} inputMode="numeric" maxLength={8}
        description={event.eligibility.mssvPrefix ? `8 chữ số, bắt đầu bằng ${event.eligibility.mssvPrefix}.` : "8 chữ số."}
        onChange={(e) => set("mssv", e.currentTarget.value.replace(/\D/g, ""))} />
      {event.eligibility.allowExternalEmail ? (
        <TextField label="Email nhận mã (không bắt buộc)" type="email" value={form.email} error={errors.email}
          description={`Để trống để dùng MSSV@${school}.`}
          onChange={(e) => set("email", e.currentTarget.value)} autoComplete="email" />
      ) : (
        <p className={styles.hint}>Mã xác minh gửi tới email trường <strong>{form.mssv.trim() || "MSSV"}@{school}</strong>.</p>
      )}
      {kind === "group" ? <p className={styles.hint}>Sau khi xác minh, bạn mời thêm 1–2 thành viên từ trang đội; mỗi người xác nhận qua email của họ.</p> : null}

      <Checkbox checked={form.showName} onChange={(value) => set("showName", value)}>Hiện họ tên của tôi trên trang giải (MSSV và email không bao giờ công khai).</Checkbox>
      <Checkbox checked={form.consent} onChange={(value) => set("consent", value)} error={errors.consent}>
        Tôi đồng ý với{" "}
        {onShowRules ? <button type="button" className={styles.linkButton} onClick={onShowRules}>thể lệ giải</button> : "thể lệ giải"}
        {" "}và cho phép Ban tổ chức xử lý họ tên, MSSV, email để tổ chức giải.
      </Checkbox>

      <TurnstileWidget siteKey={event.turnstileSiteKey} onToken={turnstile.setToken} resetKey={turnstile.resetKey} />
      <FormAlert message={alert} />
      <Button type="submit" disabled={busy}>{busy ? "Đang gửi…" : "Đăng ký và nhận mã"}</Button>
    </form>
  );
}

export interface OtpStepProps {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly handle: string;
  readonly sentTo: string | null;
  readonly onVerified: (team: TeamView) => void;
}

/** Enter the 6-digit code sent to the captain; can ask for a new code. */
export function OtpStep({ gateway, event, handle, sentTo: initialSentTo, onVerified }: OtpStepProps) {
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState(initialSentTo);
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstile = useTurnstileToken();

  const verify = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setAlert({ message: "Mã gồm 6 chữ số.", tone: "error" });
      return;
    }
    setBusy(true);
    setAlert(null);
    try {
      onVerified(await gateway.verifyRegistration(handle, code));
    } catch (error) {
      setAlert({ message: botCupErrorMessage(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!turnstile.token) {
      setAlert({ message: "Hãy hoàn tất bước xác minh bạn không phải máy.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const result = await gateway.resendRegistration(handle, turnstile.token);
      setSentTo(result.otpSentTo);
      setCode("");
      setAlert({ message: `Đã gửi mã mới tới ${result.otpSentTo}.`, tone: "success" });
    } catch (error) {
      setAlert({ message: botCupErrorMessage(error), tone: "error" });
    } finally {
      turnstile.consume();
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={verify} noValidate aria-labelledby="bot-cup-otp-title">
      <h2 id="bot-cup-otp-title">Nhập mã xác minh</h2>
      <p>
        {sentTo ? <>Mã 6 chữ số đã gửi tới <strong>{sentTo}</strong>. </> : null}
        Mã có hiệu lực 10 phút. Nếu không thấy, hãy xem cả mục Thư rác / Junk.
      </p>
      <TextField label="Mã xác minh" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
        onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))} />
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>Xác minh</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={resend}>Gửi lại mã</Button>
      </div>
      <TurnstileWidget siteKey={event.turnstileSiteKey} onToken={turnstile.setToken} resetKey={turnstile.resetKey} />
    </form>
  );
}
