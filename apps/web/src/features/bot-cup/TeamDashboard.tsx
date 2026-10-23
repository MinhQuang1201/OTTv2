import { useState, type FormEvent } from "react";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import type { BotCupApiGateway, BotCupEvent, TeamMember, TeamView } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage, teamStatusLabel } from "./botCupMessages";
import { formatDateTime } from "./botCupFormat";
import { FormAlert, MSSV_PATTERN } from "./formParts";
import { PracticePanel } from "./PracticePanel";
import { SubmissionsPanel } from "./SubmissionsPanel";
import styles from "./botCup.module.css";

export interface TeamDashboardProps {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly team: TeamView;
  readonly onTeamChange: (team: TeamView) => void;
  readonly onSignedOut: (message?: string) => void;
  /** Opens a game's replay in the replay viewer; without it the team page shows no replay button. */
  readonly onOpenReplay?: (document: unknown) => void;
}

function nextStep(team: TeamView, event: BotCupEvent): string {
  if (team.status === "active") {
    if (!event.practiceOpensAt) return "Đội đã đủ điều kiện. Ban tổ chức sẽ thông báo ngày mở nộp bài.";
    if (event.serverTime < event.practiceOpensAt) return `Đội đã đủ điều kiện. Nộp bài mở từ ${formatDateTime(event.practiceOpensAt)}.`;
    return "Đội đã đủ điều kiện. Hãy nộp bot ở mục Nộp bài bên dưới.";
  }
  if (team.members.length < 2) return "Mời thêm 1–2 thành viên. Đội nhóm cần 2–3 người và mọi người phải xác nhận qua email.";
  const waiting = team.members.filter((member) => member.status === "pending").length;
  return `Còn ${waiting} thành viên chưa xác nhận. Nhắc họ mở email mời (xem cả Thư rác / Junk).`;
}

/** The signed-in team's page (plan §11.3): status, members, invites, submissions, settings. */
export function TeamDashboard({ gateway, event, team, onTeamChange, onSignedOut, onOpenReplay }: TeamDashboardProps) {
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canChangeMembers = event.registrationOpen && team.kind === "group";

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setAlert(null);
    try {
      await action();
    } catch (error) {
      if ((error as { code?: string }).code === "unauthorized") onSignedOut(BOT_CUP_ERROR_MESSAGES.unauthorized);
      else setAlert({ message: botCupErrorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const remove = (member: TeamMember) => {
    if (!window.confirm(`Xoá ${member.fullName} khỏi đội?`)) return;
    void run(`remove:${member.mssv}`, async () => {
      onTeamChange(await gateway.removeMember(member.mssv));
      setAlert({ message: `Đã xoá ${member.fullName}.`, tone: "success" });
    });
  };

  const resend = (member: TeamMember) => run(`resend:${member.mssv}`, async () => {
    const result = await gateway.resendInvite(member.mssv);
    setAlert({ message: `Đã gửi lại lời mời tới ${result.sentTo}.`, tone: "success" });
  });

  return (
    <div className={styles.dashboard}>
      <Panel heading={team.displayName} className={styles.teamCard}>
        <p className={styles.teamMeta}>
          <span>Tên đăng nhập: <strong>{team.handle}</strong></span>
          <span>{team.kind === "group" ? "Đội nhóm" : "Đội cá nhân"}</span>
          <Badge status={team.status === "active" ? "success" : "warning"}>{teamStatusLabel(team.status)}</Badge>
        </p>
        <p>{nextStep(team, event)}</p>
      </Panel>

      <Panel heading="Thành viên">
        <ul className={styles.memberList}>
          {team.members.map((member) => (
            <li key={member.mssv} className={styles.member}>
              <div>
                <strong>{member.fullName}</strong>{member.role === "captain" ? " · Đội trưởng" : ""}
                <div className={styles.memberMeta}>{member.mssv} · {member.email}</div>
              </div>
              <Badge status={member.status === "confirmed" ? "success" : "warning"}>{member.status === "confirmed" ? "Đã xác nhận" : "Chờ xác nhận"}</Badge>
              {canChangeMembers && member.role !== "captain" ? (
                <div className={styles.memberActions}>
                  {member.status === "pending" ? (
                    <Button variant="quiet" disabled={busy !== null} onClick={() => void resend(member)}>Gửi lại lời mời</Button>
                  ) : null}
                  <Button variant="danger" disabled={busy !== null} onClick={() => remove(member)}>Xoá</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {canChangeMembers && team.members.length < 3 ? (
          <AddMemberForm gateway={gateway} event={event} busy={busy !== null} onAdded={(updated, name) => {
            onTeamChange(updated);
            setAlert({ message: `Đã gửi lời mời tới ${name}.`, tone: "success" });
          }} onError={(message) => setAlert({ message, tone: "error" })} />
        ) : null}
        {!event.registrationOpen && team.kind === "group" ? <p className={styles.hint}>Đã hết hạn đăng ký: thành viên đội đã được khóa.</p> : null}
        <FormAlert message={alert?.message ?? null} tone={alert?.tone} />
      </Panel>

      <SubmissionsPanel gateway={gateway} event={event} team={team} onSignedOut={onSignedOut} />
      {team.status === "active" ? <PracticePanel gateway={gateway} onSignedOut={onSignedOut} onOpenReplay={onOpenReplay} /> : null}

      <AccountSettings gateway={gateway} onSignedOut={onSignedOut} />
    </div>
  );
}

function AddMemberForm({ gateway, event, busy, onAdded, onError }: {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly busy: boolean;
  readonly onAdded: (team: TeamView, name: string) => void;
  readonly onError: (message: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [mssv, setMssv] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{ fullName?: string; mssv?: string }>({});
  const [sending, setSending] = useState(false);

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    const found: { fullName?: string; mssv?: string } = {};
    if (fullName.trim().length < 2) found.fullName = BOT_CUP_ERROR_MESSAGES.full_name_invalid;
    if (!MSSV_PATTERN.test(mssv)) found.mssv = BOT_CUP_ERROR_MESSAGES.mssv_invalid;
    else if (event.eligibility.mssvPrefix && !mssv.startsWith(event.eligibility.mssvPrefix)) found.mssv = BOT_CUP_ERROR_MESSAGES.mssv_not_eligible;
    setErrors(found);
    if (found.fullName || found.mssv) return;
    setSending(true);
    try {
      const team = await gateway.addMember({ fullName: fullName.trim(), mssv, ...(email.trim() ? { email: email.trim() } : {}) });
      onAdded(team, fullName.trim());
      setFullName("");
      setMssv("");
      setEmail("");
    } catch (error) {
      onError(botCupErrorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit} noValidate aria-label="Mời thành viên">
      <h3 className={styles.subheading}>Mời thành viên</h3>
      <TextField label="Họ và tên" value={fullName} error={errors.fullName} maxLength={64} onChange={(e) => setFullName(e.currentTarget.value)} />
      <TextField label="MSSV" value={mssv} error={errors.mssv} inputMode="numeric" maxLength={8} onChange={(e) => setMssv(e.currentTarget.value.replace(/\D/g, ""))} />
      {event.eligibility.allowExternalEmail ? (
        <TextField label="Email (không bắt buộc)" type="email" value={email} description={`Để trống để gửi tới MSSV@${event.eligibility.emailDomain}.`} onChange={(e) => setEmail(e.currentTarget.value)} />
      ) : null}
      <Button type="submit" variant="secondary" disabled={busy || sending}>{sending ? "Đang gửi…" : "Gửi lời mời"}</Button>
    </form>
  );
}

function AccountSettings({ gateway, onSignedOut }: { readonly gateway: BotCupApiGateway; readonly onSignedOut: (message?: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);

  const change = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (next.length < 10) {
      setAlert({ message: BOT_CUP_ERROR_MESSAGES.password_weak, tone: "error" });
      return;
    }
    setBusy(true);
    try {
      await gateway.changePassword(current, next);
      setCurrent("");
      setNext("");
      setAlert({ message: "Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.", tone: "success" });
    } catch (error) {
      setAlert({ message: botCupErrorMessage(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    try {
      if (everywhere) await gateway.revokeAllSessions();
      else await gateway.logout();
    } catch {
      // the session is gone either way once the cookie is cleared or expired
    } finally {
      setBusy(false);
      onSignedOut(everywhere ? "Đã đăng xuất khỏi mọi thiết bị." : undefined);
    }
  };

  return (
    <Panel heading="Tài khoản">
      <form className={styles.inlineForm} onSubmit={change} noValidate aria-label="Đổi mật khẩu">
        <TextField label="Mật khẩu hiện tại" type="password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
        <TextField label="Mật khẩu mới" type="password" value={next} onChange={(e) => setNext(e.currentTarget.value)} autoComplete="new-password" />
        <Button type="submit" variant="secondary" disabled={busy}>Đổi mật khẩu</Button>
      </form>
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />
      <div className={styles.actions}>
        <Button variant="quiet" disabled={busy} onClick={() => void signOut(false)}>Đăng xuất</Button>
        <Button variant="quiet" disabled={busy} onClick={() => void signOut(true)}>Đăng xuất mọi thiết bị</Button>
      </div>
    </Panel>
  );
}
