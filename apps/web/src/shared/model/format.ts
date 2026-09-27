import type { GameResultView, Position, Seat } from "./game";

const GOAL_SQUARE: Record<Seat, Position> = {
  A: { x: 0, y: 8 },
  B: { x: 8, y: 0 },
};

export function formatSquare(position: Position): string {
  if (
    !Number.isInteger(position.x) ||
    !Number.isInteger(position.y) ||
    position.x < 0 ||
    position.x > 8 ||
    position.y < 0 ||
    position.y > 8
  ) {
    throw new RangeError("Board positions must be integers from 0 through 8");
  }

  return `${String.fromCharCode("A".charCodeAt(0) + position.x)}${position.y + 1}`;
}

export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function resultReason(result: GameResultView): string {
  if (result.reason === "goal" && result.winner) {
    return `Đưa quân vào ô thắng ${formatSquare(GOAL_SQUARE[result.winner])}.`;
  }

  switch (result.reason) {
    case "elimination":
      return "Đối phương không còn quân nào.";
    case "no_moves":
      return "Đối phương không còn nước đi hợp lệ.";
    case "timeout":
      return "Hết giờ.";
    case "disconnect_timeout":
      return "Đối thủ không kết nối lại trong thời gian cho phép.";
    case "leave":
      return "Đối thủ đã rời bàn.";
    case "goal":
      return "Ván đấu kết thúc tại ô thắng.";
  }
}
