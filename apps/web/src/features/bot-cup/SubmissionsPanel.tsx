import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, type BadgeStatus } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import type { BotCupApiGateway, BotCupEvent, Submission, SubmissionDetail, SubmissionsView, TeamView } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage } from "./botCupMessages";
import { formatDateTime } from "./botCupFormat";
import { FormAlert, StarterKitLinks } from "./formParts";
import { resultLabel } from "./matchFormat";
import styles from "./botCup.module.css";

const ACCEPT = ".py,.js,.mjs";
const REFRESH_MS = 5000;
const MAX_BYTES = 200 * 1024;

const STATUS: Readonly<Record<Submission["status"], { label: string; badge: BadgeStatus }>> = {
  checking: { label: "Chờ kiểm tra", badge: "info" },
  ready: { label: "Sẵn sàng", badge: "success" },
  build_failed: { label: "Lỗi cú pháp", badge: "danger" },
  smoke_failed: { label: "Không qua chạy thử", badge: "danger" },
};

const LANGUAGE = { python: "Python", node: "JavaScript" } as const;

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Client-side checks that save a round trip; the API repeats all of them. */
export function precheckFile(file: File): string | null {
  if (!/\.(py|m?js)$/i.test(file.name)) return BOT_CUP_ERROR_MESSAGES.submission_extension;
  if (file.size === 0) return BOT_CUP_ERROR_MESSAGES.submission_empty;
  if (file.size > MAX_BYTES) return BOT_CUP_ERROR_MESSAGES.submission_too_large;
  return null;
}

function windowNote(view: SubmissionsView): string | null {
  if (view.window.open) return null;
  if (view.window.reason === "submissions_not_open") {
    return view.window.practiceOpensAt
      ? `Nộp bài mở từ ${formatDateTime(view.window.practiceOpensAt)}.`
      : "Nộp bài sẽ mở khi giai đoạn luyện tập bắt đầu.";
  }
  return BOT_CUP_ERROR_MESSAGES[view.window.reason ?? ""] ?? null;
}

/** "Nộp bài" on the team page (plan §6.2, §11.3): upload, versions with SHA-256 receipts, the final submission. */
export function SubmissionsPanel({ gateway, event, team, onSignedOut }: {
  readonly gateway: BotCupApiGateway;
  readonly event: BotCupEvent;
  readonly team: TeamView;
  readonly onSignedOut: (message?: string) => void;
}) {
  const [view, setView] = useState<SubmissionsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);

  const fail = useCallback((error: unknown) => {
    if ((error as { code?: string }).code === "unauthorized") onSignedOut(BOT_CUP_ERROR_MESSAGES.unauthorized);
    else setAlert({ message: botCupErrorMessage(error), tone: "error" });
  }, [onSignedOut]);

  useEffect(() => {
    if (team.status !== "active") return;
    const controller = new AbortController();
    gateway.listSubmissions(controller.signal).then(setView, (error) => {
      if ((error as { name?: string }).name === "AbortError") return;
      if ((error as { code?: string }).code === "unauthorized") onSignedOut(BOT_CUP_ERROR_MESSAGES.unauthorized);
      else setLoadError(botCupErrorMessage(error));
    });
    return () => controller.abort();
  }, [gateway, team.status, onSignedOut]);

  // A new version waits for the runner's syntax check and smoke test; check back until it is settled.
  const checking = view?.submissions.some((submission) => submission.status === "checking") ?? false;
  useEffect(() => {
    if (!checking) return;
    const timer = window.setInterval(() => {
      gateway.listSubmissions().then(setView, () => undefined);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [checking, gateway]);

  if (team.status !== "active") {
    return (
      <Panel heading="Nộp bài">
        <p className={styles.hint}>Nộp bài mở cho đội đã đủ thành viên xác nhận. Bot viết bằng Python 3.12 hoặc JavaScript (Node 22), một file, tối đa 200 KB.</p>
      </Panel>
    );
  }

  const upload = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!file) {
      setAlert({ message: "Chọn file bot trước.", tone: "error" });
      return;
    }
    const problem = precheckFile(file);
    if (problem) {
      setAlert({ message: problem, tone: "error" });
      return;
    }
    setBusy("upload");
    setAlert(null);
    try {
      const { submission } = await gateway.uploadSubmission(file);
      setView(await gateway.listSubmissions());
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setAlert({ message: `Đã nhận phiên bản ${submission.version}. SHA-256: ${submission.sha256}`, tone: "success" });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const choose = async (submission: Submission | null) => {
    setBusy(submission ? `final:${submission.id}` : "final:auto");
    setAlert(null);
    try {
      setView(await gateway.chooseFinalSubmission(submission?.id ?? null));
      setAlert({
        message: submission ? `Bản thi đấu: phiên bản ${submission.version}.` : "Bản thi đấu sẽ là phiên bản hợp lệ mới nhất.",
        tone: "success",
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const toggleDetail = async (submission: Submission) => {
    if (detail?.id === submission.id) {
      setDetail(null);
      return;
    }
    try {
      setDetail((await gateway.getSubmission(submission.id)).submission);
    } catch (error) {
      fail(error);
    }
  };

  const note = view ? windowNote(view) : null;
  const finalLocked = view?.window.finalLocked ?? false;

  return (
    <Panel heading="Nộp bài" className={styles.submissionsCard}>
      <p className={styles.hint}>
        Một file .py (Python 3.12, thư viện chuẩn) hoặc .js / .mjs (Node 22, chạy dạng ES module), tối đa 200 KB.
        Mỗi đội nộp tối đa 10 lần mỗi ngày. Mã SHA-256 của từng phiên bản là biên nhận khi có tranh chấp.
        {event.codeFreezeAt ? ` Khóa code lúc ${formatDateTime(event.codeFreezeAt)}.` : ""}
      </p>
      <details className={styles.kitBox}>
        <summary>Bộ khởi đầu: bot mẫu và trọng tài chạy trên máy</summary>
        <StarterKitLinks />
      </details>
      {loadError ? <FormAlert message={loadError} /> : null}
      {!view && !loadError ? <p className={styles.hint} role="status">Đang tải danh sách bài nộp…</p> : null}
      {note ? <p className={styles.hint}>{note}</p> : null}

      {view?.window.open ? (
        <form className={styles.uploadForm} onSubmit={upload} aria-label="Nộp bài">
          <label className={styles.fileField}>
            <span>File bot</span>
            <input ref={fileInput} type="file" accept={ACCEPT} onChange={(changeEvent) => setFile(changeEvent.currentTarget.files?.[0] ?? null)} />
          </label>
          <Button type="submit" disabled={busy !== null}>{busy === "upload" ? "Đang nộp…" : "Nộp bài"}</Button>
          <span className={styles.hint}>Hôm nay đã nộp {view.quota.usedToday}/{view.quota.perDay}.</span>
        </form>
      ) : null}
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />

      {view && view.submissions.length === 0 ? <p className={styles.hint}>Đội chưa nộp phiên bản nào.</p> : null}
      {view && view.submissions.length > 0 ? (
        <>
          <p className={styles.hint}>
            {view.finalChosen ? "Đội đã tự chọn Bản thi đấu." : "Bản thi đấu mặc định là phiên bản hợp lệ mới nhất."}
            {" "}Phiên bản đang chờ kiểm tra vẫn chọn được; lúc khóa code chỉ bản đã qua kiểm tra mới được niêm phong.
          </p>
          <ol className={styles.submissionList} aria-label="Các phiên bản đã nộp">
            {view.submissions.map((submission) => {
              const isFinal = submission.id === view.finalSubmissionId;
              const eligible = submission.status === "checking" || submission.status === "ready";
              return (
                <li key={submission.id} className={styles.submission} aria-current={isFinal ? "true" : undefined}>
                  <div className={styles.submissionHead}>
                    <strong>Phiên bản {submission.version}</strong>
                    <Badge status={STATUS[submission.status].badge}>{STATUS[submission.status].label}</Badge>
                    {isFinal ? <Badge status="success">Bản thi đấu</Badge> : null}
                  </div>
                  <div className={styles.memberMeta}>
                    {submission.filename} · {LANGUAGE[submission.language]} · {sizeLabel(submission.size)} · {formatDateTime(submission.createdAt)}
                  </div>
                  <code className={styles.sha} title="SHA-256">{submission.sha256}</code>
                  <div className={styles.memberActions}>
                    {!isFinal && eligible && !finalLocked ? (
                      <Button variant="secondary" disabled={busy !== null} onClick={() => void choose(submission)}>Chọn làm Bản thi đấu</Button>
                    ) : null}
                    <a className={styles.link} href={gateway.submissionSourceUrl(submission.id)} download>Tải mã</a>
                    <Button variant="quiet" onClick={() => void toggleDetail(submission)} aria-expanded={detail?.id === submission.id}>Kết quả kiểm tra</Button>
                  </div>
                  {detail?.id === submission.id ? (
                    <div className={styles.checkDetail}>
                      <pre className={styles.log}>{detail.checkLog ?? "Máy chấm chưa kiểm tra phiên bản này."}</pre>
                      {detail.smoke.length ? (
                        <ul className={styles.smokeList} aria-label="Ván chạy thử">
                          {detail.smoke.map((game) => (
                            <li key={game.id}>
                              Ván chạy thử cầm {game.seat === "A" ? "Đỏ" : "Xanh"} với AI Dễ: {resultLabel({ ...game, mySeat: game.seat })}
                              {game.stderr ? <pre className={styles.log}>{game.stderr}</pre> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {view.finalChosen && !finalLocked ? (
            <Button variant="quiet" disabled={busy !== null} onClick={() => void choose(null)}>Dùng phiên bản mới nhất</Button>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
