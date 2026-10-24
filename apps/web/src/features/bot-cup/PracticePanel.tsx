import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import type { BotCupApiGateway, MatchView, MyMatches } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage } from "./botCupMessages";
import { formatDateTime } from "./botCupFormat";
import { FormAlert } from "./formParts";
import { MAP_LABELS, STAGE_LABELS, resultLabel, resultTone } from "./matchFormat";
import styles from "./botCup.module.css";

const REFRESH_MS = 5000;

/** Practice against house bots and the team's games with replays (plan §7.1 stage 1, §11.3). */
export function PracticePanel({ gateway, onSignedOut, onOpenReplay }: {
  readonly gateway: BotCupApiGateway;
  readonly onSignedOut: (message?: string) => void;
  readonly onOpenReplay?: (document: unknown) => void;
}) {
  const [data, setData] = useState<MyMatches | null>(null);
  const [opponent, setOpponent] = useState("easy");
  const [mapId, setMapId] = useState("classic");
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stderr, setStderr] = useState<{ id: string; text: string } | null>(null);

  const handle = useCallback((error: unknown) => {
    if ((error as { code?: string }).code === "unauthorized") onSignedOut(BOT_CUP_ERROR_MESSAGES.unauthorized);
    else setAlert({ message: botCupErrorMessage(error), tone: "error" });
  }, [onSignedOut]);

  const refresh = useCallback((signal?: AbortSignal) => gateway.listMatches(signal).then(setData, (error) => {
    if ((error as { name?: string }).name !== "AbortError") handle(error);
  }), [gateway, handle]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // While games wait for or run on the runner, check back every few seconds.
  const pending = data?.matches.some((match) => match.status === "queued" || match.status === "running") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const start = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setBusy("start");
    setAlert(null);
    try {
      await gateway.requestPractice(opponent, mapId);
      await refresh();
      setAlert({ message: "Đã xếp 2 ván luyện tập (mỗi màu một ván). Kết quả hiện ở đây khi máy chấm chạy xong.", tone: "success" });
    } catch (error) {
      handle(error);
    } finally {
      setBusy(null);
    }
  };

  const openReplay = async (match: MatchView) => {
    setBusy(`replay:${match.id}`);
    setAlert(null);
    try {
      const { replay } = await gateway.getMatchReplay(match.id);
      onOpenReplay?.(replay);
    } catch (error) {
      handle(error);
    } finally {
      setBusy(null);
    }
  };

  const showStderr = async (match: MatchView) => {
    if (stderr?.id === match.id) {
      setStderr(null);
      return;
    }
    try {
      const detail = await gateway.getMatch(match.id);
      const text = match.mySeat ? detail.match.stderr[match.mySeat] ?? "" : "";
      setStderr({ id: match.id, text: text || "(bot không ghi gì ra stderr)" });
    } catch (error) {
      handle(error);
    }
  };

  return (
    <Panel heading="Luyện tập và trận đấu" className={styles.submissionsCard}>
      <p className={styles.hint}>
        Đấu Bản thi đấu của đội với house bot của BTC. Mỗi lần bấm là 2 ván (đội cầm Đỏ một ván, Xanh một ván), tối đa
        {" "}{data?.practice.gamesPerDay ?? 20} ván mỗi ngày. Chỉ bản đã qua kiểm tra mới đấu được.
      </p>
      {data ? (
        <form className={styles.uploadForm} onSubmit={start} aria-label="Đấu luyện tập">
          <label className={styles.fileField}>
            <span>Đối thủ</span>
            <select value={opponent} onChange={(event) => setOpponent(event.currentTarget.value)}>
              {data.practice.opponents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className={styles.fileField}>
            <span>Bản đồ</span>
            <select value={mapId} onChange={(event) => setMapId(event.currentTarget.value)}>
              {data.practice.maps.map((item) => <option key={item} value={item}>{MAP_LABELS[item] ?? item}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={busy !== null}>{busy === "start" ? "Đang xếp…" : "Đấu 2 ván"}</Button>
          <span className={styles.hint}>Hôm nay: {data.practice.usedToday}/{data.practice.gamesPerDay} ván.</span>
        </form>
      ) : <p className={styles.hint} role="status">Đang tải trận đấu…</p>}
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />

      {data && data.matches.length === 0 ? <p className={styles.hint}>Chưa có trận nào.</p> : null}
      {data && data.matches.length > 0 ? (
        <ol className={styles.submissionList} aria-label="Trận của đội">
          {data.matches.map((match) => {
            const opponentSeat = match.mySeat === "A" ? match.seats.B : match.seats.A;
            return (
              <li key={match.id} className={styles.submission}>
                <div className={styles.submissionHead}>
                  <strong>{STAGE_LABELS[match.stage] ?? match.stage}</strong>
                  <span>vs {opponentSeat.name}</span>
                  <Badge status={resultTone(match)}>{resultLabel(match)}</Badge>
                </div>
                <div className={styles.memberMeta}>
                  {MAP_LABELS[match.mapId] ?? match.mapId} · đội cầm {match.mySeat === "A" ? "Đỏ (đi trước)" : "Xanh"}
                  {match.plies !== null ? ` · ${match.plies} nước` : ""} · {formatDateTime(match.createdAt)}
                </div>
                {match.status === "finished" ? (
                  <div className={styles.memberActions}>
                    {onOpenReplay ? (
                      <Button variant="secondary" disabled={busy !== null} onClick={() => void openReplay(match)}>
                        {busy === `replay:${match.id}` ? "Đang mở…" : "Xem replay"}
                      </Button>
                    ) : null}
                    <Button variant="quiet" onClick={() => void showStderr(match)} aria-expanded={stderr?.id === match.id}>Log stderr</Button>
                  </div>
                ) : null}
                {stderr?.id === match.id ? <pre className={styles.log}>{stderr.text}</pre> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </Panel>
  );
}
