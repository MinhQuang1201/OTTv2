import type { TournamentStandingView } from "./types";
import styles from "./tournaments.module.css";

export interface TournamentStandingsTableProps {
  readonly standings: readonly TournamentStandingView[];
}

export function TournamentStandingsTable({ standings }: TournamentStandingsTableProps) {
  if (!standings || standings.length === 0) {
    return <p className={styles.helperText}>Chưa có dữ liệu bảng xếp hạng.</p>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table className={styles.standingsTable} aria-label="Bảng xếp hạng giải đấu">
        <thead>
          <tr>
            <th>Hạng</th>
            <th>Người chơi</th>
            <th>Trận</th>
            <th>Thắng</th>
            <th>Hòa</th>
            <th>Thua</th>
            <th>Điểm</th>
            <th title="Buchholz (tổng điểm đối thủ)">BH</th>
            <th title="Sonneborn-Berger">SB</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((s) => (
            <tr key={s.participantId}>
              <td>{s.rank}</td>
              <td><strong>{s.name}</strong></td>
              <td>{s.matchesPlayed}</td>
              <td>{s.wins}</td>
              <td>{s.draws}</td>
              <td>{s.losses}</td>
              <td><strong>{s.points}</strong></td>
              <td>{s.buchholz}</td>
              <td>{s.sonnebornBerger}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
