import { useEffect, useState } from "react";
import { Panel } from "../../shared/ui/Panel";
import { Spinner } from "../../shared/ui/Spinner";
import type { BotCupApiGateway, Leaderboard } from "./BotCupApiGateway";
import { botCupErrorMessage } from "./botCupMessages";
import { formatDateTime } from "./botCupFormat";
import { FormAlert } from "./formParts";
import styles from "./botCup.module.css";

const score = (points: number) => (Number.isInteger(points) ? String(points) : points.toFixed(1).replace(".", ","));

/** Public practice leaderboard (plan §11.2): each team's final submission against the house bots. */
export function LeaderboardPanel({ gateway }: { readonly gateway: BotCupApiGateway }) {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    gateway.getLeaderboard(controller.signal).then(setBoard, (cause) => {
      if (!controller.signal.aborted) setError(botCupErrorMessage(cause));
    });
    return () => controller.abort();
  }, [gateway]);

  return (
    <Panel heading="Bảng xếp hạng luyện tập">
      <p className={styles.hint}>
        Kết quả Bản thi đấu hiện tại của mỗi đội khi đấu luyện tập với house bot, dạng điểm/số ván (thắng 1, hòa 0,5).
        Xếp theo tỉ lệ điểm trước đối thủ mạnh nhất. Đây chưa phải kết quả giải.
      </p>
      {error ? <FormAlert message={error} /> : null}
      {!board && !error ? <Spinner label="Đang tải bảng xếp hạng" /> : null}
      {board && board.rows.length === 0 ? <p className={styles.hint}>Chưa có đội nào đấu luyện tập.</p> : null}
      {board && board.rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.schedule}>
            <caption className={styles.hint}>Cập nhật {formatDateTime(board.updatedAt)}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Đội</th>
                {board.opponents.map((opponent) => <th key={opponent.id} scope="col">{opponent.name}</th>)}
                <th scope="col">Số ván</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row) => (
                <tr key={row.rank}>
                  <td>{row.rank}</td>
                  <th scope="row">{row.displayName}</th>
                  {board.opponents.map((opponent) => {
                    const cell = row.opponents[opponent.id];
                    return <td key={opponent.id}>{cell && cell.played ? `${score(cell.points)}/${cell.played}` : "—"}</td>;
                  })}
                  <td>{row.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
