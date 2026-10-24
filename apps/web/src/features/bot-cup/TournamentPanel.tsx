import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { Spinner } from "../../shared/ui/Spinner";
import type { Appeal, AppealStage, BotCupApiGateway, KnockoutGame, KnockoutPairing, ResultStage, TournamentView } from "./BotCupApiGateway";
import { botCupErrorMessage } from "./botCupMessages";
import { formatDateTime } from "./botCupFormat";
import { FormAlert } from "./formParts";
import { MAP_LABELS, reasonLabel } from "./matchFormat";
import styles from "./botCup.module.css";

const PHASE_LABELS: Readonly<Record<string, string>> = {
  registration: "Đang đăng ký và luyện tập",
  practice: "Đang luyện tập",
  frozen: "Đã khóa code, bài thi đã niêm phong",
  gate: "Đang đấu vòng kiểm tra",
  qualifying: "Đang đấu vòng loại",
  verification: "BTC đang phỏng vấn code",
  knockout: "Đang đấu loại trực tiếp",
  finished: "Giải đã kết thúc",
};

export const RESULT_STAGE_LABELS: Readonly<Record<ResultStage, string>> = {
  sealed: "Danh sách bài niêm phong",
  gate: "Kết quả vòng kiểm tra",
  qualifying: "Kết quả vòng loại",
  final: "Kết quả chung cuộc",
};

const APPEAL_STAGES: readonly AppealStage[] = ["gate", "qualifying", "final"];
const SLOT_LABELS: Readonly<Record<string, string>> = { SF1: "Bán kết 1", SF2: "Bán kết 2", F: "Chung kết", "3RD": "Tranh hạng ba" };

const score = (points: number) => (Number.isInteger(points) ? String(points) : points.toFixed(1).replace(".", ","));

function gameLine(pairing: KnockoutPairing, game: KnockoutGame): string {
  const red = game.red === "a" ? pairing.red : pairing.blue;
  const blue = game.red === "a" ? pairing.blue : pairing.red;
  const head = `Ván ${game.gameIndex + 1} · ${MAP_LABELS[game.mapId] ?? game.mapId} · Đỏ ${red}`;
  if (game.status === "queued" || game.status === "running") return `${head} · đang chờ`;
  if (game.status !== "finished") return `${head} · BTC sẽ chạy lại`;
  if (game.outcome === "draw") return `${head} · hòa (${reasonLabel(game.reason)})`;
  return `${head} · ${game.winner === "A" ? red : blue} thắng (${reasonLabel(game.reason)})`;
}

/** Published tournament results (plan §8.8): standings, bracket and documents whose SHA-256 anyone can check. */
export function TournamentPanel({ gateway, signedIn, onOpenReplay }: {
  readonly gateway: BotCupApiGateway;
  readonly signedIn: boolean;
  readonly onOpenReplay?: (document: unknown) => void;
}) {
  const [view, setView] = useState<TournamentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Readonly<Record<string, "checking" | "ok" | "bad" | "error">>>({});
  const [replayError, setReplayError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    gateway.getTournament(controller.signal).then(setView, (cause) => {
      if (!controller.signal.aborted) setError(botCupErrorMessage(cause));
    });
    return () => controller.abort();
  }, [gateway]);

  const verify = async (stage: ResultStage, sha256: string) => {
    setChecks((current) => ({ ...current, [stage]: "checking" }));
    try {
      const ok = await gateway.verifyResultDocument(stage, sha256);
      setChecks((current) => ({ ...current, [stage]: ok ? "ok" : "bad" }));
    } catch {
      setChecks((current) => ({ ...current, [stage]: "error" }));
    }
  };

  const openReplay = async (matchId: string) => {
    setReplayError(null);
    try {
      const { replay } = await gateway.getMatchReplay(matchId);
      onOpenReplay?.(replay);
    } catch (cause) {
      setReplayError(botCupErrorMessage(cause));
    }
  };

  if (error) return <Panel heading="Kết quả giải"><FormAlert message={error} /></Panel>;
  if (!view) return <Panel heading="Kết quả giải"><Spinner label="Đang tải kết quả giải" /></Panel>;

  return (
    <div className={styles.results}>
      <Panel heading="Kết quả giải" className={styles.submissionsCard}>
        <p><Badge status="info">{PHASE_LABELS[view.phase] ?? view.phase}</Badge></p>
        {view.documents.length === 0 ? <p className={styles.hint}>Chưa công bố kết quả nào. Danh sách bài niêm phong có ngay sau giờ khóa code.</p> : (
          <ul className={styles.announcements} aria-label="Tài liệu kết quả đã công bố">
            {view.documents.map((doc) => (
              <li key={doc.stage}>
                <h3 className={styles.subheading}>{RESULT_STAGE_LABELS[doc.stage] ?? doc.stage}</h3>
                <p className={styles.hint}>Công bố {formatDateTime(doc.publishedAt)}</p>
                <p className={styles.hint}>SHA-256: <code className={styles.sha}>{doc.sha256}</code></p>
                <div className={styles.docActions}>
                  <a href={gateway.resultDocumentUrl(doc.stage)} target="_blank" rel="noopener noreferrer">Tải JSON</a>
                  <Button variant="secondary" disabled={checks[doc.stage] === "checking"} onClick={() => void verify(doc.stage, doc.sha256)}>Kiểm tra SHA-256</Button>
                  <span role="status" className={styles.hint}>
                    {checks[doc.stage] === "ok" ? "Khớp: tài liệu chưa bị sửa." : null}
                    {checks[doc.stage] === "bad" ? "KHÔNG khớp. Hãy báo BTC." : null}
                    {checks[doc.stage] === "error" ? "Không tải được tài liệu." : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {view.standings.format ? (
        <Panel heading={`Bảng vòng loại · ${view.standings.format === "round_robin" ? "vòng tròn" : "Swiss"}`} className={styles.submissionsCard}>
          <p className={styles.hint}>
            {view.standings.format === "round_robin"
              ? "Mỗi cặp đấu 6 ván (3 bản đồ × 2 màu). Thắng ván 1 điểm, hòa 0,5; điểm bảng là tổng điểm các ván."
              : "Mỗi vòng, mỗi cặp đấu 2 ván đổi màu trên bản đồ của vòng. Thắng ván 1 điểm, hòa 0,5; bye được 2 điểm."}
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.schedule}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Đội</th>
                  <th scope="col">Điểm</th>
                  <th scope="col">Ván thắng</th>
                  <th scope="col">Số ván</th>
                  {view.standings.format === "swiss" ? <th scope="col">Buchholz-1</th> : null}
                  <th scope="col">SB</th>
                </tr>
              </thead>
              <tbody>
                {view.standings.rows.map((row) => (
                  <tr key={row.rank}>
                    <td>{row.rank}</td>
                    <th scope="row">{row.displayName}</th>
                    <td>{score(row.points)}</td>
                    <td>{row.wins}</td>
                    <td>{row.games}</td>
                    {view.standings.format === "swiss" ? <td>{score(row.buchholzCut1 ?? 0)}</td> : null}
                    <td>{score(row.sb ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {view.knockout.length ? (
        <Panel heading="Loại trực tiếp" className={styles.submissionsCard}>
          <FormAlert message={replayError} />
          <ol className={styles.submissionList} aria-label="Các cặp loại trực tiếp">
            {view.knockout.map((pairing) => (
              <li key={pairing.slot} className={styles.submission}>
                <h3 className={styles.subheading}>
                  {SLOT_LABELS[pairing.slot] ?? pairing.slot}: {pairing.red} ({pairing.seeds[0]}) {score(pairing.points[0])} – {score(pairing.points[1])} {pairing.blue} ({pairing.seeds[1]})
                </h3>
                <p className={styles.hint}>
                  {pairing.winner ? `${pairing.winner} đi tiếp${pairing.decidedBySeed ? " (hòa sau tie-break, hạt giống cao hơn đi tiếp)" : ""}.` : "Chưa phân thắng thua."}
                  {pairing.tiebreaks ? ` Đã đấu ${pairing.tiebreaks} lượt tie-break.` : ""}
                </p>
                <ul className={styles.gameList}>
                  {pairing.games.map((game) => (
                    <li key={game.id}>
                      <span>{gameLine(pairing, game)}</span>
                      {onOpenReplay && game.status === "finished" ? (
                        <Button variant="secondary" onClick={() => void openReplay(game.id)}>Xem replay</Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {signedIn ? <AppealsPanel gateway={gateway} published={view.documents.map((doc) => doc.stage)} /> : null}
    </div>
  );
}

/** A team's appeals (plan §8.9): at most 3 per stage, inside the window after that stage's results are published. */
export function AppealsPanel({ gateway, published }: { readonly gateway: BotCupApiGateway; readonly published: readonly ResultStage[] }) {
  const [appeals, setAppeals] = useState<readonly Appeal[] | null>(null);
  const [stage, setStage] = useState<AppealStage>("gate");
  const [text, setText] = useState("");
  const [matchId, setMatchId] = useState("");
  const [alert, setAlert] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const stages = APPEAL_STAGES.filter((item) => published.includes(item));

  const refresh = useCallback((signal?: AbortSignal) => gateway.listAppeals(signal).then((result) => setAppeals(result.appeals), (cause) => {
    if ((cause as { name?: string }).name !== "AbortError") setAlert({ message: botCupErrorMessage(cause), tone: "error" });
  }), [gateway]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (stages.length && !stages.includes(stage)) setStage(stages[stages.length - 1]);
  }, [stages, stage]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setAlert(null);
    try {
      await gateway.createAppeal(stage, text.trim(), matchId.trim() || undefined);
      setText("");
      setMatchId("");
      setAlert({ message: "Đã gửi khiếu nại. BTC sẽ trả lời tại đây.", tone: "success" });
      await refresh();
    } catch (cause) {
      setAlert({ message: botCupErrorMessage(cause), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel heading="Khiếu nại" className={styles.submissionsCard}>
      <p className={styles.hint}>
        Chỉ đội có bài niêm phong được gửi, trong thời hạn sau khi công bố kết quả giai đoạn đó, tối đa 3 khiếu nại mỗi giai đoạn.
        Ghi rõ mã trận (nếu có) và điều bạn cho là sai.
      </p>
      {stages.length ? (
        <form className={styles.appealForm} onSubmit={submit} aria-label="Gửi khiếu nại">
          <label className={styles.fileField}>
            <span>Giai đoạn</span>
            <select value={stage} onChange={(event) => setStage(event.currentTarget.value as AppealStage)}>
              {stages.map((item) => <option key={item} value={item}>{RESULT_STAGE_LABELS[item]}</option>)}
            </select>
          </label>
          <label className={styles.fileField}>
            <span>Mã trận (không bắt buộc)</span>
            <input value={matchId} maxLength={64} onChange={(event) => setMatchId(event.currentTarget.value)} />
          </label>
          <label className={styles.appealText}>
            <span>Nội dung (10–2000 ký tự)</span>
            <textarea value={text} rows={4} minLength={10} maxLength={2000} required onChange={(event) => setText(event.currentTarget.value)} />
          </label>
          <Button type="submit" disabled={busy || text.trim().length < 10}>{busy ? "Đang gửi…" : "Gửi khiếu nại"}</Button>
        </form>
      ) : <p className={styles.hint}>Chưa có kết quả nào để khiếu nại.</p>}
      <FormAlert message={alert?.message ?? null} tone={alert?.tone} />
      {appeals && appeals.length ? (
        <ol className={styles.submissionList} aria-label="Khiếu nại của đội">
          {appeals.map((item) => (
            <li key={item.id} className={styles.submission}>
              <p className={styles.hint}>
                {RESULT_STAGE_LABELS[item.stage]} · {formatDateTime(item.createdAt)}{item.matchId ? ` · trận ${item.matchId}` : ""}{" "}
                <Badge status={item.status === "answered" ? "success" : "warning"}>{item.status === "answered" ? "Đã trả lời" : "Chờ BTC"}</Badge>
              </p>
              <p className={styles.announcementBody}>{item.body}</p>
              {item.response ? <p className={styles.announcementBody}><strong>BTC:</strong> {item.response}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  );
}
