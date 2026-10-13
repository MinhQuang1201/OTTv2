"""Arena Bot Protocol v1 Python SDK.

Provides minimal TURN-only protocol adapter for Arena child processes.
Standard output is strictly reserved for single-line NDJSON responses.
Diagnostic logging is directed strictly to standard error (sys.stderr).
Zero game rules or movement reimplementation: choices are picked from referee legalMoves.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Callable, Dict, Optional, Tuple, Union

PROTOCOL_VERSION: int = 1


def log(*args: Any, sep: str = " ", end: str = "\n") -> None:
    """Writes diagnostic message strictly to standard error (stderr) and flushes."""
    msg = sep.join(str(a) for a in args) + end
    sys.stderr.write(msg)
    sys.stderr.flush()


def run_bot(
    choose_move_fn: Callable[
        [Dict[str, Any]],
        Union[
            Dict[str, Any],
            Tuple[Dict[str, Any], Optional[str]],
        ],
    ]
) -> None:
    """Runs the synchronous TURN-only NDJSON loop over stdin/stdout.

    Parameters:
        choose_move_fn: A function taking the parsed turn dictionary and returning
                        either a move dict: {"from": {"x": int, "y": int}, "to": {"x": int, "y": int}}
                        or a tuple: (move_dict, optional_comment_string).
    """
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            turn = json.loads(line)
        except Exception as json_err:
            log(f"Invalid JSON received on stdin: {json_err}")
            continue

        if not isinstance(turn, dict):
            log(f"Expected JSON object for turn, got {type(turn).__name__}")
            continue

        if turn.get("protocolVersion") != PROTOCOL_VERSION:
            log(f"Mismatched protocolVersion: expected {PROTOCOL_VERSION}, got {turn.get('protocolVersion')}")
            continue

        if turn.get("type") != "turn":
            log(f"Ignored non-turn message type: {turn.get('type')}")
            continue

        request_id = turn.get("requestId")
        if not request_id or not isinstance(request_id, str):
            log("Missing or invalid requestId in turn message")
            continue

        # Invoke user bot strategy
        try:
            result = choose_move_fn(turn)
        except Exception as bot_err:
            log(f"Exception raised in choose_move_fn: {bot_err}")
            sys.exit(1)

        comment: Optional[str] = None
        if isinstance(result, tuple) and len(result) == 2:
            move_dict, comment = result
        elif isinstance(result, dict):
            move_dict = result
        else:
            log(f"choose_move_fn must return a move dict or (move_dict, comment), got {type(result).__name__}")
            sys.exit(1)

        if not isinstance(move_dict, dict) or "from" not in move_dict or "to" not in move_dict:
            log(f"Invalid move format from bot: {move_dict}")
            sys.exit(1)

        try:
            from_pos = {
                "x": int(move_dict["from"]["x"]),
                "y": int(move_dict["from"]["y"]),
            }
            to_pos = {
                "x": int(move_dict["to"]["x"]),
                "y": int(move_dict["to"]["y"]),
            }
        except (KeyError, TypeError, ValueError) as coord_err:
            log(f"Invalid coordinates in move: {coord_err}")
            sys.exit(1)

        response: Dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "move": {
                "from": from_pos,
                "to": to_pos,
            },
        }

        if comment is not None:
            # Bound comment to 2048 characters max per protocol v1
            response["comment"] = str(comment)[:2048]

        # Single-line JSON response on stdout, immediately flushed
        serialized = json.dumps(response, separators=(",", ":"))
        sys.stdout.write(serialized + "\n")
        sys.stdout.flush()
