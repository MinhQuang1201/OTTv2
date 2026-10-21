"""Reference First-Legal Python Bot for Arena AI protocol v1.

Demonstrates minimal compliant bot using the official Python SDK.
Selects the first legal move from referee-provided legalMoves array.
Diagnostic logs are directed strictly to stderr; stdout is reserved for NDJSON.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add sdk/arena/python to sys.path so ott_bot is importable directly
SDK_DIR = Path(__file__).resolve().parent.parent / "python"
if str(SDK_DIR) not in sys.path:
    sys.path.insert(0, str(SDK_DIR))

from ott_bot import log, run_bot


def choose_first_legal(turn):
    """Picks the first legal move provided by the referee."""
    legal_moves = turn.get("legalMoves")
    if not legal_moves or len(legal_moves) == 0:
        log("No legal moves available in turn payload!")
        raise RuntimeError("No legal moves available in turn payload")

    move = legal_moves[0]
    comment = f"Python first-legal ply {turn.get('ply')}"
    return move, comment


if __name__ == "__main__":
    run_bot(choose_first_legal)
