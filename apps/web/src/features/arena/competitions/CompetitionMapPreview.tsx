import { useMemo } from "react";
import type { MapDescriptor, MapInitialPiece } from "./types";
import styles from "./competitions.module.css";

export interface CompetitionMapPreviewProps {
  readonly map: MapDescriptor;
  readonly className?: string;
}

const SIZE = 9;
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;

const TYPE_VN: Record<string, string> = {
  dam: "Đấm",
  la: "Lá",
  keo: "Kéo",
};

const TYPE_SYMBOL: Record<string, string> = {
  dam: "Đ",
  la: "L",
  keo: "K",
};

export function CompetitionMapPreview({ map, className }: CompetitionMapPreviewProps) {
  const pieces = map.initialState?.pieces ?? [];

  // Build a lookup map of pieces by coordinate string "x,y"
  const pieceMap = useMemo(() => {
    const lookup = new Map<string, MapInitialPiece>();
    for (const piece of pieces) {
      lookup.set(`${piece.x},${piece.y}`, piece);
    }
    return lookup;
  }, [pieces]);

  // Statistics
  const stats = useMemo(() => {
    let countA = 0;
    let countB = 0;
    for (const p of pieces) {
      const owner = p.player || p.seat;
      if (owner === "A") countA++;
      else if (owner === "B") countB++;
    }
    return { countA, countB, total: pieces.length };
  }, [pieces]);

  // Ranks 9 down to 1 (corresponding to y = 8 down to 0)
  const rankIndices = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  const fileIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div
      className={[styles.mapPreviewBox, className || ""].join(" ")}
      role="region"
      aria-label={`Xem trước bản đồ ${map.name}`}
      data-testid="map-preview-container"
    >
      <div className={styles.mapPreviewHeader}>
        <div>
          <strong style={{ fontSize: "var(--ui-text-sm)", color: "var(--ui-text)" }}>
            Bản đồ: {map.name} (v{map.revision})
          </strong>
          <p style={{ margin: "2px 0 0 0", fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>
            {map.description}
          </p>
        </div>
        <div style={{ fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>
          Lực lượng: <span style={{ color: "var(--ui-seat-a, #e63946)", fontWeight: 700 }}>Đỏ (A): {stats.countA}</span> ·{" "}
          <span style={{ color: "var(--ui-seat-b, #457b9d)", fontWeight: 700 }}>Xanh (B): {stats.countB}</span>
        </div>
      </div>

      <div style={{ overflowX: "auto", padding: "4px 0" }}>
        <table
          className={styles.boardGridTable}
          role="grid"
          aria-label={`Bàn cờ 9x9 bản đồ ${map.name}`}
          data-testid="map-grid-table"
        >
          <caption className="sr-only" style={{ display: "none" }}>
            Bản đồ thi đấu 9x9: 81 ô với vị trí xuất phát quân cờ
          </caption>
          <thead>
            <tr>
              <th className={styles.boardCoordinate} aria-hidden="true" />
              {FILES.map((file) => (
                <th key={file} className={styles.boardCoordinate} aria-hidden="true">
                  {file}
                </th>
              ))}
              <th className={styles.boardCoordinate} aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rankIndices.map((y) => {
              const rank = y + 1;
              return (
                <tr key={`rank-${rank}`}>
                  {/* Left rank label */}
                  <th className={styles.boardCoordinate} aria-hidden="true">
                    {rank}
                  </th>

                  {/* 9 columns for this rank */}
                  {fileIndices.map((x) => {
                    const file = FILES[x];
                    const coordKey = `${x},${y}`;
                    const piece = pieceMap.get(coordKey);
                    const isGoalA = x === 0 && y === 0; // a1
                    const isGoalB = x === 8 && y === 8; // i9
                    const isDark = (x + y) % 2 === 1;

                    let cellAriaLabel = `Ô ${file}${rank}: Ô trống`;
                    let pieceOwner: "A" | "B" | null = null;
                    let pieceTypeLabel = "";

                    if (piece) {
                      pieceOwner = piece.player || piece.seat || "A";
                      pieceTypeLabel = TYPE_VN[piece.type] || piece.type;
                      const seatText = pieceOwner === "A" ? "Ghế A (Đỏ)" : "Ghế B (Xanh)";
                      cellAriaLabel = `Ô ${file}${rank}: Quân ${pieceTypeLabel} (${seatText})`;
                    } else if (isGoalA) {
                      cellAriaLabel = `Ô ${file}${rank}: Ô Đích Ghế A - Đỏ (Trống)`;
                    } else if (isGoalB) {
                      cellAriaLabel = `Ô ${file}${rank}: Ô Đích Ghế B - Xanh (Trống)`;
                    }

                    const cellClasses = [
                      styles.boardCell,
                      isDark ? styles.boardCellDark : "",
                      isGoalA ? styles.boardCellGoalA : "",
                      isGoalB ? styles.boardCellGoalB : "",
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <td
                        key={coordKey}
                        className={cellClasses}
                        role="gridcell"
                        aria-label={cellAriaLabel}
                        data-testid={`map-cell-${file}${rank}`}
                        data-x={x}
                        data-y={y}
                      >
                        {piece ? (
                          <span
                            className={pieceOwner === "A" ? styles.pieceBadgeA : styles.pieceBadgeB}
                            title={`${pieceTypeLabel} (${pieceOwner === "A" ? "Ghế A" : "Ghế B"})`}
                          >
                            {TYPE_SYMBOL[piece.type] || piece.type[0].toUpperCase()}
                          </span>
                        ) : isGoalA ? (
                          <span className={styles.goalMarkerText} title="Đích Ghế A">
                            ĐÍCH A
                          </span>
                        ) : isGoalB ? (
                          <span className={styles.goalMarkerText} title="Đích Ghế B">
                            ĐÍCH B
                          </span>
                        ) : null}
                      </td>
                    );
                  })}

                  {/* Right rank label */}
                  <th className={styles.boardCoordinate} aria-hidden="true">
                    {rank}
                  </th>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className={styles.boardCoordinate} aria-hidden="true" />
              {FILES.map((file) => (
                <th key={file} className={styles.boardCoordinate} aria-hidden="true">
                  {file}
                </th>
              ))}
              <th className={styles.boardCoordinate} aria-hidden="true" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Map Legend */}
      <div className={styles.mapLegend} aria-hidden="true">
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <span className={styles.pieceBadgeA}>Đ</span>
          <span className={styles.pieceBadgeA}>L</span>
          <span className={styles.pieceBadgeA}>K</span>
          <span>Ghế A (Đỏ)</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <span className={styles.pieceBadgeB}>Đ</span>
          <span className={styles.pieceBadgeB}>L</span>
          <span className={styles.pieceBadgeB}>K</span>
          <span>Ghế B (Xanh)</span>
        </span>
        <span style={{ color: "var(--ui-seat-a, #e63946)", fontWeight: 600 }}>
          [Đích A: a1]
        </span>
        <span style={{ color: "var(--ui-seat-b, #457b9d)", fontWeight: 600 }}>
          [Đích B: i9]
        </span>
      </div>
    </div>
  );
}
