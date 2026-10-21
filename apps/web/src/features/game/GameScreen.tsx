import { useEffect, useRef, useState } from "react";
import { InviteBanner } from "./InviteBanner";
import type { GameSession } from "../../sessions/contract";
import { useSessionSnapshot } from "../../sessions/useSessionSnapshot";
import type { GameSnapshot, Seat } from "../../shared/model/game";
import { useAppToasts } from "../../app/AppProviders";
import { Board } from "./Board";
import { ConfirmLeaveDialog } from "./ConfirmLeaveDialog";
import { GameTopBar } from "./GameTopBar";
import { MoveHistory } from "./MoveHistory";
import { PlayerPanel } from "./PlayerPanel";
import { TurnStatus } from "./TurnStatus";
import { ResultDialog } from "../result/ResultDialog";
import { getSoundEnabled, setSoundEnabled } from "../../shared/audio/soundPreferences";
import { playSynthesizedSound } from "../../shared/audio/soundSynthesis";
import { useReplayShortcuts } from "../replay/useReplayShortcuts";
import styles from "./game.module.css";

export interface GameScreenProps {
  readonly session: GameSession;
  readonly snapshot: GameSnapshot;
  readonly onLobby: () => void;
}

export function GameScreen({ session, snapshot: initialSnapshot, onLobby }: GameScreenProps) {
  const snapshot = useSessionSnapshot(session);
  const activeSnapshot = snapshot.mode === "demo" && snapshot.phase === "idle" && initialSnapshot.phase !== "idle" ? initialSnapshot : snapshot;
  const { pushToast } = useAppToasts();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [resultOpen, setResultOpen] = useState(activeSnapshot.phase === "finished");
  const currentMaxEventId = activeSnapshot.events.reduce((max, e) => Math.max(max, e.id), 0);
  const highestEventId = useRef(currentMaxEventId);
  const highestAudioEventId = useRef(currentMaxEventId);
  const prevSessionRef = useRef(session);

  if (prevSessionRef.current !== session) {
    prevSessionRef.current = session;
    highestEventId.current = currentMaxEventId;
    highestAudioEventId.current = currentMaxEventId;
  }

  const [effectQueue, setEffectQueue] = useState<number[]>([]);
  const effectEventId = effectQueue[0] ?? null;
  const spectator = activeSnapshot.viewer?.role === "spectator";

  const [perspective, setPerspective] = useState<"A" | "B">(() =>
    activeSnapshot.viewerSeat === "B" ? "B" : "A"
  );
  const prevViewerSeatRef = useRef(activeSnapshot.viewerSeat);
  useEffect(() => {
    if (prevViewerSeatRef.current !== activeSnapshot.viewerSeat) {
      prevViewerSeatRef.current = activeSnapshot.viewerSeat;
      setPerspective(activeSnapshot.viewerSeat === "B" ? "B" : "A");
    }
  }, [activeSnapshot.viewerSeat]);

  const [soundEnabled, setSoundState] = useState<boolean>(() => getSoundEnabled());

  const handleFlipPerspective = () => {
    setPerspective((prev) => (prev === "A" ? "B" : "A"));
  };

  const handleToggleSound = () => {
    setSoundState((prev) => {
      const next = !prev;
      setSoundEnabled(next);
      return next;
    });
  };

  useReplayShortcuts({
    onFlipPerspective: handleFlipPerspective,
    onToggleSound: handleToggleSound,
    enabled: !confirmLeave && !resultOpen,
  });

  useEffect(() => {
    setEffectQueue([]);
    setResultOpen(activeSnapshot.phase === "finished");
    setConfirmLeave(false);
  }, [session]);

  useEffect(() => {
    const unseen = activeSnapshot.events
      .filter((event) => event.id > highestEventId.current)
      .sort((left, right) => left.id - right.id);
    if (unseen.length === 0) return;
    highestEventId.current = unseen[unseen.length - 1]!.id;
    const visualIds = unseen
      .filter((event) => event.type === "capture" || event.type === "strike_loss" || event.type === "win")
      .map((event) => event.id);
    if (visualIds.length > 0) setEffectQueue((current) => [...current, ...visualIds]);
  }, [activeSnapshot.events]);

  useEffect(() => {
    if (effectQueue.length === 0) return;
    const timer = window.setTimeout(() => setEffectQueue((current) => current.slice(1)), 240);
    return () => window.clearTimeout(timer);
  }, [effectQueue]);

  useEffect(() => {
    if (activeSnapshot.result) setResultOpen(true);
  }, [activeSnapshot.result]);

  useEffect(() => {
    const unseen = activeSnapshot.events
      .filter((event) => event.id > highestAudioEventId.current)
      .sort((left, right) => left.id - right.id);
    if (unseen.length === 0) return;
    highestAudioEventId.current = unseen[unseen.length - 1]!.id;

    if (!soundEnabled) return;
    const latest = unseen[unseen.length - 1]!;
    if (latest.type === "win") {
      playSynthesizedSound("win");
    } else if (latest.type === "capture" || latest.type === "strike_loss") {
      playSynthesizedSound("capture");
    } else if (latest.type === "move") {
      playSynthesizedSound("move");
    }
  }, [activeSnapshot.events, soundEnabled]);

  const leave = async () => {
    if (spectator) {
      onLobby();
      return;
    }
    if (activeSnapshot.capabilities.canLeaveGame) {
      setConfirmLeave(true);
      return;
    }
    await session.leave();
    onLobby();
  };
  const confirm = async () => {
    setConfirmLeave(false);
    await session.leave();
    onLobby();
  };
  const onError = (error: { message: string; code: string }) => pushToast(error.message, error.code === "invalid_move" ? "error" : "warning");
  const names: Partial<Record<Seat, string>> = { A: activeSnapshot.players.A?.name ?? "An", B: activeSnapshot.players.B?.name ?? "Bình" };

  const lastMoveEvent = [...activeSnapshot.events]
    .reverse()
    .find((e) => e.type === "move" || e.type === "capture" || e.type === "strike_loss");

  const highlightMove = lastMoveEvent
    ? { from: lastMoveEvent.from, to: lastMoveEvent.to }
    : null;

  const lastCapture = lastMoveEvent?.type === "capture" || lastMoveEvent?.type === "strike_loss"
    ? lastMoveEvent.to
    : null;

  return <section className={styles.gameScreen} aria-labelledby="game-title" data-testid="game-screen">
     <GameTopBar
       roomId={activeSnapshot.roomId}
       connection={activeSnapshot.connection}
       spectator={spectator}
       spectatorCount={activeSnapshot.spectatorCount}
       onLeave={() => void leave()}
       perspective={perspective}
       onFlipPerspective={handleFlipPerspective}
       soundEnabled={soundEnabled}
       onToggleSound={handleToggleSound}
     />
    <div className={styles.gameLayout}>
      <div className={styles.players}>
         <PlayerPanel player={activeSnapshot.players.B} active={activeSnapshot.turn === "B"} viewer={activeSnapshot.viewerSeat === "B"} spectator={spectator} />
         <PlayerPanel player={activeSnapshot.players.A} active={activeSnapshot.turn === "A"} viewer={activeSnapshot.viewerSeat === "A"} spectator={spectator} />
      </div>
       <main className={styles.boardColumn} aria-labelledby="game-title">
         <h1 id="game-title">Bàn chơi</h1>
        <TurnStatus snapshot={activeSnapshot} />
        {!spectator && activeSnapshot.phase === "waiting" && activeSnapshot.roomAlias ? (
          <InviteBanner code={activeSnapshot.roomAlias} onCopied={(message, ok) => pushToast(message, ok ? "success" : "warning")} />
        ) : null}
        <div className={effectEventId !== null ? styles.effects : undefined} data-event-id={effectEventId ?? undefined}>
          <Board
            session={session}
            snapshot={activeSnapshot}
            onError={onError}
            perspective={perspective}
            highlightMove={highlightMove}
            lastCapture={lastCapture}
          />
        </div>
      </main>
      <MoveHistory events={activeSnapshot.events} />
    </div>
    <ConfirmLeaveDialog open={confirmLeave} onCancel={() => setConfirmLeave(false)} onConfirm={() => void confirm()} />
    <ResultDialog open={resultOpen && activeSnapshot.phase === "finished"} result={activeSnapshot.result} viewerSeat={activeSnapshot.viewerSeat} playerNames={names} onClose={() => setResultOpen(false)} onLobby={onLobby} />
  </section>;
}
