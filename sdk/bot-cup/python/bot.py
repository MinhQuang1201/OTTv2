"""Bot mẫu OTT Bot Cup (Python 3.12, chỉ thư viện chuẩn).

Mỗi lượt, trọng tài gửi MỘT dòng JSON qua stdin; bot trả lời MỘT dòng JSON qua stdout.
Muốn in log để gỡ lỗi thì dùng log(...) (ghi ra stderr). Đừng print() ra stdout: trọng tài sẽ xử thua.

Chạy thử: node judge.mjs bot.py easy   (xem GUIDE.vi.md)
"""

import json
import sys

# Loại quân thắng loại quân nào: Đấm ăn Kéo, Kéo ăn Lá, Lá ăn Đấm.
BEATS = {"dam": "keo", "keo": "la", "la": "dam"}
# Ô thắng của mỗi ghế (x = cột 0..8, y = hàng 0..8). A thắng ở (0, 0), B thắng ở (8, 8).
GOAL = {"A": (0, 0), "B": (8, 8)}


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def choose_move(turn):
    """Trả về một nước trong turn["legalMoves"].

    turn có các trường chính:
      turn["turn"]             ghế của bot: "A" hoặc "B"
      turn["board"]            danh sách quân: {"id", "owner": "A"/"B", "type": "dam"/"la"/"keo", "x", "y"}
      turn["legalMoves"]       mọi nước hợp lệ: {"from": {"x", "y"}, "to": {"x", "y"}}
      turn["ply"]              số thứ tự nước trong ván (từ 1)
      turn["turnTimeLimitMs"]  thời gian tối đa cho nước này
      turn["timeRemainingMs"]  quỹ thời gian còn lại của bot
    """
    moves = turn["legalMoves"]

    # ===== Viết chiến thuật ở đây =====
    # Ví dụ: đi thẳng vào ô thắng nếu được.
    goal_x, goal_y = GOAL[turn["turn"]]
    for move in moves:
        if move["to"]["x"] == goal_x and move["to"]["y"] == goal_y:
            return move

    return moves[0]


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        turn = json.loads(line)
        if turn.get("type") != "turn":
            continue
        move = choose_move(turn)
        reply = {"protocolVersion": 1, "requestId": turn["requestId"], "move": move}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
