/** Vietnamese labels for Bot Cup games (plan §7.2): who won, why, from one team's point of view. */
import type { MatchView } from "./BotCupApiGateway";

const REASONS: Readonly<Record<string, string>> = {
  goal: "vào ô thắng",
  elimination: "tiêu diệt hết quân",
  no_moves: "đối thủ hết nước đi",
  max_plies: "đủ 300 nước",
  turn_timeout: "quá giờ một nước",
  total_timeout: "hết quỹ thời gian",
  crash: "bot dừng hoặc lỗi",
  protocol_error: "sai giao thức",
  illegal_move: "nước không hợp lệ",
  output_limit: "in quá nhiều",
};

export const MAP_LABELS: Readonly<Record<string, string>> = { classic: "Classic", flanks: "Flanks", center: "Center" };

export const STAGE_LABELS: Readonly<Record<string, string>> = {
  smoke: "Chạy thử",
  practice: "Luyện tập",
  gate: "Vòng kiểm tra",
  round_robin: "Vòng tròn",
  swiss: "Swiss",
  knockout: "Knockout",
};

export function reasonLabel(reason: string | null): string {
  return reason ? REASONS[reason] ?? reason : "";
}

/** "Thắng · vào ô thắng" for the team's seat, or a neutral line when the viewer did not play. */
export function resultLabel(match: Pick<MatchView, "status" | "outcome" | "winner" | "reason" | "mySeat">): string {
  if (match.status === "queued") return "Đang chờ máy chấm";
  if (match.status === "running") return "Đang đấu";
  if (match.status === "failed" || match.status === "cancelled") return "Lỗi máy chấm, BTC sẽ chạy lại";
  if (match.outcome === "draw") return `Hòa · ${reasonLabel(match.reason)}`;
  const reason = reasonLabel(match.reason);
  if (!match.mySeat) return `${match.winner === "A" ? "Đỏ" : "Xanh"} thắng · ${reason}`;
  const won = match.winner === match.mySeat;
  if (match.outcome === "forfeit") return won ? `Thắng · đối thủ ${reason}` : `Thua · bot ${reason}`;
  return `${won ? "Thắng" : "Thua"} · ${reason}`;
}

export function resultTone(match: Pick<MatchView, "status" | "outcome" | "winner" | "mySeat">): "success" | "danger" | "neutral" | "info" | "warning" {
  if (match.status === "queued" || match.status === "running") return "info";
  if (match.status !== "finished") return "warning";
  if (match.outcome === "draw" || !match.mySeat) return "neutral";
  return match.winner === match.mySeat ? "success" : "danger";
}
