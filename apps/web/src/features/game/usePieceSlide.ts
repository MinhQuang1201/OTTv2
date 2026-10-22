import { useLayoutEffect, useRef, type RefObject } from "react";
import type { PieceView } from "../../shared/model/game";
import { prefersReducedMotion } from "./captureFx";

export const SLIDE_MS = 180;
/** A jump larger than this many moved pieces is a seek or resync, not a move. */
const MAX_SLIDING_PIECES = 2;

/**
 * FLIP slide for pieces that moved one square since the previous render.
 * Both the old and the new cell are measured after layout, so resizes between
 * moves cannot skew the start point. Perspective flips and multi-piece jumps
 * (replay seeks, reconnect snapshots) are drawn without motion.
 */
export function usePieceSlide(gridRef: RefObject<HTMLElement | null>, board: readonly PieceView[], perspective: "A" | "B") {
  const previous = useRef<{ readonly positions: Map<string, { x: number; y: number }>; readonly perspective: "A" | "B" } | null>(null);
  const running = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const positions = new Map(board.map((piece) => [piece.id, piece.position] as const));
    const before = previous.current;
    previous.current = { positions, perspective };
    const grid = gridRef.current;
    if (before && before.perspective !== perspective) {
      // Cells moved under the pieces (local play flips the board after each move); a slide would start from the wrong place.
      for (const animation of running.current) animation.cancel?.();
      running.current = [];
      return;
    }
    if (!before || !grid || prefersReducedMotion()) return;

    const moved = board.filter((piece) => {
      const old = before.positions.get(piece.id);
      if (!old || (old.x === piece.position.x && old.y === piece.position.y)) return false;
      return Math.max(Math.abs(old.x - piece.position.x), Math.abs(old.y - piece.position.y)) === 1;
    });
    if (moved.length === 0 || moved.length > MAX_SLIDING_PIECES) return;

    for (const piece of moved) {
      const old = before.positions.get(piece.id)!;
      const id = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(piece.id) : piece.id;
      const element = grid.querySelector<HTMLElement>(`[data-piece-id="${id}"]`);
      const fromCell = grid.querySelector<HTMLElement>(`[data-x="${old.x}"][data-y="${old.y}"]`);
      const toCell = grid.querySelector<HTMLElement>(`[data-x="${piece.position.x}"][data-y="${piece.position.y}"]`);
      if (!element || !fromCell || !toCell || typeof element.animate !== "function") continue;
      const from = fromCell.getBoundingClientRect();
      const to = toCell.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      // Cells clip their content; lift the destination cell while the piece travels across the border.
      toCell.dataset.sliding = "true";
      const animation = element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
      running.current.push(animation);
      const done = () => {
        delete toCell.dataset.sliding;
        running.current = running.current.filter((item) => item !== animation);
      };
      animation.addEventListener?.("finish", done);
      animation.addEventListener?.("cancel", done);
    }
  }, [board, gridRef, perspective]);
}
