import sys
import json

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            turn = json.loads(line)
            legal_moves = turn.get("legalMoves", [])
            if legal_moves:
                action = {
                    "protocolVersion": 1,
                    "requestId": turn.get("requestId"),
                    "move": legal_moves[0],
                    "comment": "isolated python legal move"
                }
                sys.stdout.write(json.dumps(action) + "\n")
                sys.stdout.flush()
        except Exception as err:
            sys.stderr.write(f"legal-isolated-bot.py error: {err}\n")

if __name__ == "__main__":
    main()
