import "../../../../../packages/game-core/src/config.js";
import { describe, expect, it } from "vitest";
import type { GameEventView, PieceView } from "../../shared/model/game";
import {
  BEATS,
  INITIAL_COUNTS,
  MAX_QUEUED_EFFECTS,
  blockedTargets,
  captureAnnouncement,
  captureCue,
  captureEffectFor,
  captureLabel,
  capturedCounts,
  effectDurationMs,
  effectsForEvents,
  enqueueEffects,
  historyEntries,
  identifyPiece,
} from "./captureFx";

const piece = (id: string, seat: "A" | "B", type: "dam" | "la" | "keo", x: number, y: number): PieceView => ({ id, seat, type, position: { x, y } });
const capture = (id: number, pieceId: string, capturedId: string, capturedType?: "dam" | "la" | "keo"): GameEventView => ({
  id, type: "capture", pieceId, capturedId, ...(capturedType ? { capturedType } : {}), from: { x: 5, y: 3 }, to: { x: 5, y: 2 },
});

describe("captureFx", () => {
  it("mirrors the rules engine's beats table and starting setup", () => {
    const config = (globalThis as unknown as { OTT_CONFIG: { BEATS: unknown; A_SETUP: { type: "dam" | "la" | "keo" }[] } }).OTT_CONFIG;
    expect(BEATS).toEqual(config.BEATS);
    const counts = { dam: 0, la: 0, keo: 0 };
    for (const spot of config.A_SETUP) counts[spot.type] += 1;
    expect(INITIAL_COUNTS).toEqual(counts);
  });

  it("identifies pieces from the board first, then from core ids", () => {
    expect(identifyPiece("x", [piece("x", "B", "keo", 0, 0)])).toEqual({ seat: "B", type: "keo" });
    expect(identifyPiece("A-la-3", [])).toEqual({ seat: "A", type: "la" });
    expect(identifyPiece("custom", [])).toBeNull();
  });

  it("describes a capture with the authoritative captured kind", () => {
    const board = [piece("B-keo-2", "B", "keo", 5, 2)];
    const effect = captureEffectFor(capture(6, "B-keo-2", "A-la-1", "la"), board)!;
    expect(effect).toEqual({ id: 6, at: { x: 5, y: 2 }, attacker: { seat: "B", type: "keo" }, captured: { seat: "A", type: "la" } });
    expect(captureLabel(effect)).toBe("✂ Kéo ăn 📄 Lá");
    expect(captureAnnouncement(effect, "F3")).toBe("Kéo Xanh ăn Lá Đỏ tại F3.");
  });

  it("falls back to the beats table when only one side is known", () => {
    expect(captureEffectFor(capture(1, "B-keo-2", "opaque"), [])?.captured).toEqual({ seat: "A", type: "la" });
    expect(captureEffectFor(capture(1, "opaque", "x", "dam"), [piece("unrelated", "A", "la", 0, 0)])).toBeNull();
    expect(captureEffectFor(capture(1, "opaque", "A-dam-0"), [])?.attacker).toEqual({ seat: "B", type: "la" });
  });

  it("queues capture and win effects in event order and drops the oldest beyond the cap", () => {
    const events: GameEventView[] = [
      { id: 1, type: "move", pieceId: "A-la-0", from: { x: 0, y: 1 }, to: { x: 0, y: 0 } },
      capture(2, "A-dam-1", "B-keo-0", "keo"),
      { id: 3, type: "win", winner: "A", reason: "goal" },
    ];
    const effects = effectsForEvents(events, []);
    expect(effects.map((effect) => effect.id)).toEqual([2, 3]);
    expect(effects[1]!.capture).toBeNull();

    const many = Array.from({ length: MAX_QUEUED_EFFECTS + 2 }, (_, index) => ({ id: index + 10, capture: null }));
    expect(enqueueEffects(effects, many).map((effect) => effect.id)).toEqual(many.slice(-MAX_QUEUED_EFFECTS).map((effect) => effect.id));
  });

  it("shortens capture effects under reduced motion", () => {
    const effect = effectsForEvents([capture(2, "A-dam-1", "B-keo-0", "keo")], [])[0]!;
    expect(effectDurationMs(effect, false)).toBe(900);
    expect(effectDurationMs(effect, true)).toBe(600);
    expect(effectDurationMs({ id: 3, capture: null }, true)).toBe(240);
  });

  it("uses personal capture cues only for single-seat screens", () => {
    const effect = captureEffectFor(capture(2, "A-dam-1", "B-keo-0", "keo"), [])!;
    expect(captureCue(effect, "online", "A")).toBe("captureGain");
    expect(captureCue(effect, "ai", "B")).toBe("captureLoss");
    expect(captureCue(effect, "local", "B")).toBe("capture");
    expect(captureCue(effect, "spectator", null)).toBe("capture");
  });

  it("builds readable history entries", () => {
    const entries = historyEntries([
      { id: 5, type: "move", pieceId: "A-la-0", from: { x: 4, y: 4 }, to: { x: 4, y: 3 } },
      capture(6, "B-keo-2", "A-la-1", "la"),
      { id: 7, type: "win", winner: "B", reason: "goal" },
    ], []);
    expect(entries).toEqual([
      { id: 5, mover: { seat: "A", type: "la" }, from: { x: 4, y: 4 }, to: { x: 4, y: 3 }, captured: null },
      { id: 6, mover: { seat: "B", type: "keo" }, from: { x: 5, y: 3 }, to: { x: 5, y: 2 }, captured: { seat: "A", type: "la" } },
    ]);
  });

  it("derives captured pieces from the opponent's remaining counts", () => {
    expect(capturedCounts({ dam: 3, la: 2, keo: 0 })).toEqual({ dam: 0, la: 2, keo: 3 });
    expect(capturedCounts(undefined)).toEqual({ dam: 0, la: 0, keo: 0 });
  });

  it("explains blocked neighbours without overriding legal moves", () => {
    const mover = piece("A-la-0", "A", "la", 4, 4);
    const board = [
      mover,
      piece("B-keo-0", "B", "keo", 4, 3),
      piece("B-la-0", "B", "la", 5, 5),
      piece("B-dam-0", "B", "dam", 3, 3),
      piece("A-keo-0", "A", "keo", 3, 4),
      piece("B-keo-1", "B", "keo", 6, 6),
    ];
    const blocked = blockedTargets(mover, board, [{ x: 3, y: 3 }]);
    expect(blocked).toEqual([
      { position: { x: 4, y: 3 }, hint: "Lá thua Kéo", message: "Lá thua Kéo — không đi vào ô này được." },
      { position: { x: 5, y: 5 }, hint: "Lá gặp Lá", message: "Hai quân Lá cùng loại — không ăn được nhau." },
    ]);
    expect(blockedTargets(mover, board, [{ x: 4, y: 3 }, { x: 5, y: 5 }])).toEqual([]);
  });
});
