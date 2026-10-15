import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplayDocument } from "../../sessions/contract";
import { formatSquare } from "../../shared/model/format";
import styles from "./replay.module.css";

export interface ReplayNotationProps {
  readonly document: ReplayDocument;
  readonly activePly: number;
  readonly onSeek: (ply: number) => void;
}

interface MoveEntry {
  readonly ply: number;
  readonly turnNumber: number;
  readonly seat: "A" | "B";
  readonly notation: string;
  readonly accessibleLabel: string;
}

interface TurnRow {
  readonly turnNumber: number;
  moveA?: MoveEntry;
  moveB?: MoveEntry;
}

const PIECE_GLYPHS = {
  dam: "Đ",
  la: "L",
  keo: "K",
} as const;

const PIECE_NAMES = {
  dam: "Đấm",
  la: "Lá",
  keo: "Kéo",
} as const;

export function ReplayNotation({ document, activePly, onSeek }: ReplayNotationProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [revealSpoilers, setRevealSpoilers] = useState(false);

  const turnRows = useMemo(() => {
    const rows: TurnRow[] = [];
    const frames = document.frames || [];

    for (let ply = 1; ply < frames.length; ply++) {
      const frame = frames[ply];
      const lastMove = frame?.lastMove;
      if (!lastMove) continue;

      const turnIndex = Math.floor((ply - 1) / 2);
      const turnNumber = turnIndex + 1;

      if (!rows[turnIndex]) {
        rows[turnIndex] = { turnNumber };
      }
      const currentRow = rows[turnIndex]!;

      const isRevealed = ply <= activePly || revealSpoilers;

      let notation: string;
      let accessibleLabel: string;

      if (isRevealed) {
        const priorState = frames[ply - 1]?.coreState || document.initialCoreState;
        const piece =
          priorState.pieces.find((p) => p.id === lastMove.pieceId) ||
          document.initialCoreState.pieces.find((p) => p.id === lastMove.pieceId);

        const pieceType = piece?.type ?? null;
        const glyph = pieceType ? PIECE_GLYPHS[pieceType] : "";
        const pieceName = pieceType ? PIECE_NAMES[pieceType] : null;

        const fromSq = formatSquare(lastMove.from);
        const toSq = formatSquare(lastMove.to);
        const isCapture = Boolean(lastMove.capturedPieceId || lastMove.capturedPieceType);

        const capturedName = lastMove.capturedPieceType
          ? PIECE_NAMES[lastMove.capturedPieceType]
          : null;

        notation = `${glyph ? `${glyph} ` : ""}${fromSq}${isCapture ? "x" : "-"}${toSq}`;
        accessibleLabel = `Nước ${ply}: Bên ${lastMove.seat} đi ${
          pieceName ? `${pieceName} ` : ""
        }từ ${fromSq} đến ${toSq}${capturedName ? ` ăn ${capturedName}` : ""}`;
      } else {
        // Spoiler-protected progressive entry: hides captures, piece types, and destination
        notation = `Nước ${ply}`;
        accessibleLabel = `Nước ${ply} (chưa xem - nhấp để chuyển đến)`;
      }

      const entry: MoveEntry = {
        ply,
        turnNumber,
        seat: lastMove.seat,
        notation,
        accessibleLabel,
      };

      if (lastMove.seat === "A") {
        currentRow.moveA = entry;
      } else {
        currentRow.moveB = entry;
      }
    }

    return rows;
  }, [document, activePly, revealSpoilers]);

  useEffect(() => {
    const listEl = listRef.current;
    const activeEl = activeRef.current;
    if (!listEl || !activeEl) return;

    // Calculate active element's top and bottom relative to the scroll container's content
    // using getBoundingClientRect delta + scrollTop to eliminate table offsetParent discrepancies
    const listRect = listEl.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();

    const relativeTop = activeRect.top - listRect.top + listEl.scrollTop;
    const relativeBottom = relativeTop + activeRect.height;

    const visibleTop = listEl.scrollTop;
    const visibleBottom = listEl.scrollTop + listEl.clientHeight;

    if (relativeTop < visibleTop) {
      listEl.scrollTop = Math.max(0, relativeTop);
    } else if (relativeBottom > visibleBottom) {
      listEl.scrollTop = Math.max(0, relativeBottom - listEl.clientHeight);
    }
  }, [activePly]);

  return (
    <section className={styles.notationPanel} aria-label="Biên bản ván đấu">
      <div className={styles.notationHeader}>
        <h2 className={styles.notationTitle}>Biên bản nước đi</h2>
        <div className={styles.notationActions}>
          <button
            type="button"
            className={styles.notationStartBtn}
            onClick={() => setRevealSpoilers((prev) => !prev)}
            aria-label={revealSpoilers ? "Ẩn nước đi tương lai" : "Hiện toàn bộ nước đi"}
            aria-pressed={revealSpoilers}
            data-testid="replay-notation-spoiler-toggle"
          >
            {revealSpoilers ? "Ẩn sau" : "Hiện hết"}
          </button>
          <button
            type="button"
            className={[
              styles.notationStartBtn,
              activePly === 0 ? styles.notationItemActive : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSeek(0)}
            aria-current={activePly === 0 ? "step" : undefined}
            aria-label="Vị trí bắt đầu trận đấu (nước 0)"
            data-testid="replay-ply-item-0"
            ref={activePly === 0 ? activeRef : undefined}
          >
            Ban đầu
          </button>
        </div>
      </div>

      <div ref={listRef} className={styles.notationList} role="region" aria-label="Danh sách nước đi" tabIndex={0}>
        {turnRows.length === 0 ? (
          <p className={styles.emptyNotation}>Không có nước đi nào trong ván này.</p>
        ) : (
          <table className={styles.notationTable}>
            <thead>
              <tr>
                <th scope="col" className={styles.colTurn}>Lượt</th>
                <th scope="col" className={styles.colMove}>Bên A</th>
                <th scope="col" className={styles.colMove}>Bên B</th>
              </tr>
            </thead>
            <tbody>
              {turnRows.map((row) => (
                <tr key={row.turnNumber} className={styles.notationRow}>
                  <td className={styles.turnCell}>{row.turnNumber}.</td>
                  <td className={styles.moveCell}>
                    {row.moveA ? (
                      <button
                        type="button"
                        className={[
                          styles.notationMoveBtn,
                          activePly === row.moveA.ply ? styles.notationItemActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => onSeek(row.moveA!.ply)}
                        aria-current={activePly === row.moveA.ply ? "step" : undefined}
                        aria-label={row.moveA.accessibleLabel}
                        data-testid={`replay-ply-item-${row.moveA.ply}`}
                        ref={activePly === row.moveA.ply ? activeRef : undefined}
                      >
                        {row.moveA.notation}
                      </button>
                    ) : (
                      <span className={styles.emptyMoveCell}>—</span>
                    )}
                  </td>
                  <td className={styles.moveCell}>
                    {row.moveB ? (
                      <button
                        type="button"
                        className={[
                          styles.notationMoveBtn,
                          activePly === row.moveB.ply ? styles.notationItemActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => onSeek(row.moveB!.ply)}
                        aria-current={activePly === row.moveB.ply ? "step" : undefined}
                        aria-label={row.moveB.accessibleLabel}
                        data-testid={`replay-ply-item-${row.moveB.ply}`}
                        ref={activePly === row.moveB.ply ? activeRef : undefined}
                      >
                        {row.moveB.notation}
                      </button>
                    ) : (
                      <span className={styles.emptyMoveCell}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
