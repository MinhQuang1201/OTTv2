import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReplayDocument,
  StartGameOptions,
} from "../contract";
import deterministicMatchJson from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import forfeitPly0Json from "../../../../../tests/fixtures/arena/replays/forfeit-ply0.json";
import { ReplaySession } from "./ReplaySession";

function getDeterministicMatchDoc(): ReplayDocument {
  return structuredClone(deterministicMatchJson) as unknown as ReplayDocument;
}

function getForfeitPly0Doc(): ReplayDocument {
  return structuredClone(forfeitPly0Json) as unknown as ReplayDocument;
}

describe("ReplaySession and ReplayPlaybackFacade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Contract compliance and initialization", () => {
    it("exposes complete GameSession and ReplayPlaybackFacade method surface", () => {
      const session = new ReplaySession();
      expect(typeof session.getSnapshot).toBe("function");
      expect(typeof session.subscribe).toBe("function");
      expect(typeof session.start).toBe("function");
      expect(typeof session.getLegalMoves).toBe("function");
      expect(typeof session.move).toBe("function");
      expect(typeof session.leave).toBe("function");
      expect(typeof session.dispose).toBe("function");
      expect(typeof session.getPlayback).toBe("function");
      expect(typeof session.seek).toBe("function");
      expect(typeof session.play).toBe("function");
      expect(typeof session.pause).toBe("function");
      expect(typeof session.step).toBe("function");
      expect(typeof session.setSpeed).toBe("function");
    });

    it("has expected initial idle snapshot and playback view before start", () => {
      const session = new ReplaySession();
      const snapshot = session.getSnapshot();
      expect(snapshot.mode).toBe("replay");
      expect(snapshot.phase).toBe("idle");
      expect(snapshot.boardRevision).toBe(0);
      expect(snapshot.viewer).toEqual({ role: "spectator" });
      expect(snapshot.viewerSeat).toBeNull();
      expect(snapshot.capabilities).toEqual({
        canMove: false,
        canLeaveGame: false,
        canSpectate: false,
      });

      const playback = session.getPlayback();
      expect(playback.cursor).toBe(0);
      expect(playback.maxCursor).toBe(0);
      expect(playback.isPlaying).toBe(false);
      expect(playback.speed).toBe(1);
      expect(playback.result).toBeNull();
      expect(playback.isAtStart).toBe(true);
      expect(playback.isAtEnd).toBe(true);
    });

    it("handles invalid document by failing session with error phase", async () => {
      const session = new ReplaySession();
      const listener = vi.fn();
      session.subscribe(listener);

      await session.start({
        mode: "replay",
        document: { invalid: true } as unknown as ReplayDocument,
      });

      expect(listener).toHaveBeenCalled();
      const snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error?.code).toBe("session_failed");
    });

    it("rejects unsupported start mode", async () => {
      const session = new ReplaySession();
      await session.start({ mode: "demo", scenario: "lobby-default" } as StartGameOptions);

      const snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error?.code).toBe("invalid_input");
    });
  });

  describe("Read-only guarantees and static clocks", () => {
    it("always rejects move requests with invalid_move error", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const moveResult = await session.move({ x: 4, y: 7 }, { x: 3, y: 6 });
      expect(moveResult.accepted).toBe(false);
      if (!moveResult.accepted) {
        expect(moveResult.error.code).toBe("invalid_move");
      }
    });

    it("always returns empty legal moves", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      expect(session.getLegalMoves({ x: 4, y: 7 })).toEqual([]);
      expect(session.getLegalMoves({ x: 0, y: 0 })).toEqual([]);
    });

    it("does not run live clocks with wall time ticks", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const initialClockA = session.getSnapshot().players.A?.remainingMs;
      vi.advanceTimersByTime(5000);
      const afterClockA = session.getSnapshot().players.A?.remainingMs;

      expect(afterClockA).toBe(initialClockA);
    });
  });

  describe("Multiframe playback and cursor navigation (deterministic 19-ply goal match)", () => {
    it("presents inclusive cursor 0 with initial state and playing phase", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const snapshot = session.getSnapshot();
      const playback = session.getPlayback();

      expect(playback.cursor).toBe(0);
      expect(playback.maxCursor).toBe(19);
      expect(playback.isAtStart).toBe(true);
      expect(playback.isAtEnd).toBe(false);
      expect(playback.result).toBeNull();
      expect(playback.lastMove).toBeNull();

      expect(snapshot.phase).toBe("playing");
      expect(snapshot.result).toBeNull();
      expect(snapshot.boardRevision).toBe(1);
      expect(snapshot.players.A?.name).toBe("BotA");
      expect(snapshot.players.B?.name).toBe("BotB");

      const pieceA = snapshot.board.find((p) => p.id === "A-la-0");
      expect(pieceA?.position).toEqual({ x: 4, y: 7 });
    });

    it("presents middle cursor (cursor 5) with corresponding frame state and playing phase", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(5);

      const snapshot = session.getSnapshot();
      const playback = session.getPlayback();

      expect(playback.cursor).toBe(5);
      expect(playback.isAtStart).toBe(false);
      expect(playback.isAtEnd).toBe(false);
      expect(playback.result).toBeNull();
      expect(playback.lastMove?.pieceId).toBe("A-la-0");

      expect(snapshot.phase).toBe("playing");
      expect(snapshot.result).toBeNull();
      expect(snapshot.boardRevision).toBe(2);

      const pieceA = snapshot.board.find((p) => p.id === "A-la-0");
      expect(pieceA?.position).toEqual({ x: 3, y: 4 });
    });

    it("presents final terminal cursor (cursor 19) with goal win in legacy snapshot and playback view", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(19);

      const snapshot = session.getSnapshot();
      const playback = session.getPlayback();

      expect(playback.cursor).toBe(19);
      expect(playback.isAtEnd).toBe(true);
      expect(playback.result).toEqual(doc.result);

      expect(snapshot.phase).toBe("finished");
      expect(snapshot.turn).toBeNull();
      expect(snapshot.result).toEqual({ winner: "A", reason: "goal" });

      const goalPiece = snapshot.board.find((p) => p.id === "A-la-0");
      expect(goalPiece?.position).toEqual({ x: 0, y: 0 });
    });

    it("removes terminal overlay when seeking back from final cursor to earlier cursor", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      // Seek to terminal
      session.seek(19);
      expect(session.getPlayback().result).not.toBeNull();
      expect(session.getSnapshot().phase).toBe("finished");

      // Seek back to middle
      session.seek(10);
      expect(session.getPlayback().result).toBeNull();
      expect(session.getSnapshot().phase).toBe("playing");
      expect(session.getSnapshot().result).toBeNull();
    });

    it("clamps cursor to valid bounds [0, maxCursor]", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(-5);
      expect(session.getPlayback().cursor).toBe(0);

      session.seek(100);
      expect(session.getPlayback().cursor).toBe(19);
    });

    it("does not increment boardRevision when seeking to current cursor", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const revBefore = session.getSnapshot().boardRevision;
      session.seek(0);
      expect(session.getSnapshot().boardRevision).toBe(revBefore);
    });
  });

  describe("Forfeit ply 0 fixture behavior", () => {
    it("handles forfeit ply 0: maxCursor 0, starts finished with forfeit in playback view and null in legacy snapshot", async () => {
      const doc = getForfeitPly0Doc();

      const session = new ReplaySession();
      await session.start({ mode: "replay", document: doc });

      const snapshot = session.getSnapshot();
      const playback = session.getPlayback();

      expect(playback.cursor).toBe(0);
      expect(playback.maxCursor).toBe(0);
      expect(playback.isAtStart).toBe(true);
      expect(playback.isAtEnd).toBe(true);
      expect(playback.result).toEqual(doc.result);
      expect(playback.result?.outcome).toBe("forfeit");

      // Core legacy snapshot.result is null for forfeit
      expect(snapshot.phase).toBe("finished");
      expect(snapshot.result).toBeNull();

      // Calling play at terminal does not advance or start timer
      session.play();
      expect(session.getPlayback().isPlaying).toBe(false);
    });
  });

  describe("Playback timer, speeds, pause, seek, and terminal auto-stop", () => {
    it("advances frames at base 1000ms per frame when playing at 1x speed", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      expect(session.getPlayback().isPlaying).toBe(true);

      vi.advanceTimersByTime(999);
      expect(session.getPlayback().cursor).toBe(0);

      vi.advanceTimersByTime(1);
      expect(session.getPlayback().cursor).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(session.getPlayback().cursor).toBe(2);
    });

    it("respects playback speeds 0.5, 2, and 4", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      // Test 2x speed (500ms / frame)
      session.setSpeed(2);
      session.play();
      vi.advanceTimersByTime(500);
      expect(session.getPlayback().cursor).toBe(1);
      session.pause();

      // Test 4x speed (250ms / frame)
      session.setSpeed(4);
      session.play();
      vi.advanceTimersByTime(250);
      expect(session.getPlayback().cursor).toBe(2);
      session.pause();

      // Reset to 0 and test 0.5x speed (2000ms / frame)
      session.seek(0);
      session.setSpeed(0.5);
      session.play();
      vi.advanceTimersByTime(1999);
      expect(session.getPlayback().cursor).toBe(0);
      vi.advanceTimersByTime(1);
      expect(session.getPlayback().cursor).toBe(1);
    });

    it("cancels pending timer on pause and stops advancing", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      vi.advanceTimersByTime(500);
      session.pause();
      expect(session.getPlayback().isPlaying).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(session.getPlayback().cursor).toBe(0);
    });

    it("cancels pending timer and reschedules when seeked while playing", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      vi.advanceTimersByTime(800);
      // Seek back to 0 while playing: resets countdown to full 1000ms
      session.seek(0);
      expect(session.getPlayback().isPlaying).toBe(true);

      vi.advanceTimersByTime(800);
      expect(session.getPlayback().cursor).toBe(0);

      vi.advanceTimersByTime(200);
      expect(session.getPlayback().cursor).toBe(1);
    });

    it("seeking to terminal while playing immediately stops playback", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      session.seek(19);
      expect(session.getPlayback().isPlaying).toBe(false);
      expect(session.getSnapshot().phase).toBe("finished");
    });

    it("auto-stops playback when advancing naturally to terminal frame", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(18);
      session.play();
      expect(session.getPlayback().isPlaying).toBe(true);

      vi.advanceTimersByTime(1000);
      expect(session.getPlayback().cursor).toBe(19);
      expect(session.getPlayback().isPlaying).toBe(false);
      expect(session.getSnapshot().phase).toBe("finished");
    });

    it("supports step('next'), step('prev'), and numeric step with pause behavior", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      session.step("next");
      expect(session.getPlayback().isPlaying).toBe(false);
      expect(session.getPlayback().cursor).toBe(1);

      session.step("prev");
      expect(session.getPlayback().cursor).toBe(0);

      session.step(5);
      expect(session.getPlayback().cursor).toBe(5);
    });
  });

  describe("Snapshot immutability and deep-freeze", () => {
    it("returns deeply frozen snapshot objects and arrays", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const snapshot = session.getSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.board)).toBe(true);
      expect(Object.isFrozen(snapshot.players)).toBe(true);
      expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    });
  });

  describe("Robustness: rapid interactions, unsupported fingerprints, and dispose guard", () => {
    it("tolerates rapid play/pause/seek/speed/dispose without timer leak or errors", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      for (let i = 0; i < 20; i++) {
        session.play();
        session.setSpeed((i % 2 === 0 ? 2 : 4) as any);
        session.seek(i % 10);
        session.pause();
        session.step(1);
      }

      session.dispose();
      vi.runAllTimers();
      expect(session.getPlayback().isPlaying).toBe(false);
    });

    it("displays valid snapshots for document with unsupported engineRevision fingerprint", async () => {
      const doc = getDeterministicMatchDoc();
      doc.engineRevision = "sha256:unknown-future-engine-revision";

      const session = new ReplaySession();
      await session.start({ mode: "replay", document: doc });

      const snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("playing");
      expect(snapshot.board.length).toBeGreaterThan(0);
      expect(session.getPlayback().maxCursor).toBe(19);
    });

    it("guarantees no event publication after dispose", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      const listener = vi.fn();
      session.subscribe(listener);

      session.play();
      session.dispose();
      listener.mockClear();

      vi.advanceTimersByTime(5000);
      session.seek(1);
      session.play();

      expect(listener).not.toHaveBeenCalled();
    });

    it("implements leave() as idempotent playback stopping", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.play();
      await session.leave();
      expect(session.getPlayback().isPlaying).toBe(false);

      // Calling leave again is safe
      await session.leave();
    });

    it("clones input document before ownership to prevent external mutation from affecting session", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      // Mutate external object
      (doc.participants.A as any).name = "HackedAlpha";
      (doc.result as any).reason = "hacked_reason";
      doc.frames[0].coreState.pieces[0].x = 99;

      const snapshot = session.getSnapshot();
      const playback = session.getPlayback();

      expect(snapshot.players.A?.name).toBe("BotA");
      expect(playback.participants?.A?.name).toBe("BotA");
      expect(snapshot.board[0].position.x).not.toBe(99);
    });

    it("deepFreezes and clones nested lastMove, result, and participants in getPlayback()", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(1);
      const playback1 = session.getPlayback();
      expect(playback1.lastMove).not.toBeNull();
      expect(Object.isFrozen(playback1.lastMove)).toBe(true);
      expect(Object.isFrozen(playback1.participants)).toBe(true);

      session.seek(19);
      const playbackTerminal = session.getPlayback();
      expect(playbackTerminal.result).not.toBeNull();
      expect(Object.isFrozen(playbackTerminal.result)).toBe(true);
    });

    it("deepFreezes INITIAL_REPLAY_SNAPSHOT including nested board and players", () => {
      const session = new ReplaySession();
      const snapshot = session.getSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.board)).toBe(true);
      expect(Object.isFrozen(snapshot.players)).toBe(true);
      expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
      expect(Object.isFrozen(snapshot.waitingRooms)).toBe(true);
      expect(Object.isFrozen(snapshot.events)).toBe(true);
    });

    it("guards seek() against non-finite values (NaN, Infinity, -Infinity, non-number) without corrupting cursor", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      await session.start({ mode: "replay", document: doc });

      session.seek(5);
      expect(session.getPlayback().cursor).toBe(5);

      session.seek(NaN);
      expect(session.getPlayback().cursor).toBe(5);

      session.seek(Infinity);
      expect(session.getPlayback().cursor).toBe(5);

      session.seek(-Infinity);
      expect(session.getPlayback().cursor).toBe(5);

      session.seek("invalid" as any);
      expect(session.getPlayback().cursor).toBe(5);
    });

    it("resets active timer and cursor to 0 on repeated start() without double timer leak", async () => {
      const session = new ReplaySession();
      const doc1 = getDeterministicMatchDoc();
      const doc2 = getDeterministicMatchDoc();

      await session.start({ mode: "replay", document: doc1 });
      session.play();
      vi.advanceTimersByTime(1000);
      expect(session.getPlayback().cursor).toBe(1);

      const listener = vi.fn();
      session.subscribe(listener);

      // Repeated start while playing
      await session.start({ mode: "replay", document: doc2 });
      expect(listener).toHaveBeenCalled();
      expect(session.getPlayback().cursor).toBe(0);
      expect(session.getPlayback().isPlaying).toBe(false);

      // Advancing timer should not advance cursor (old timer must be cleared)
      vi.advanceTimersByTime(2000);
      expect(session.getPlayback().cursor).toBe(0);

      // Now start playing again - should have exactly single timer
      session.play();
      vi.advanceTimersByTime(1000);
      expect(session.getPlayback().cursor).toBe(1);
    });

    it("disposed start() returns early and does not mutate or notify", async () => {
      const session = new ReplaySession();
      const doc = getDeterministicMatchDoc();
      const listener = vi.fn();
      session.subscribe(listener);

      session.dispose();
      listener.mockClear();

      await session.start({ mode: "replay", document: doc });
      expect(listener).not.toHaveBeenCalled();
      expect(session.getPlayback().cursor).toBe(0);
      expect(session.getSnapshot().phase).toBe("idle");
    });
  });
});
