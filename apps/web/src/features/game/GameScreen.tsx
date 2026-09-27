import { useEffect, useRef, useState } from "react";
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
  const highestEventId = useRef(0);
  const [effectQueue, setEffectQueue] = useState<number[]>([]);
  const effectEventId = effectQueue[0] ?? null;

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

  const leave = async () => {
    if (activeSnapshot.mode === "online") {
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

  return <section className={styles.gameScreen} aria-labelledby="game-title">
    <GameTopBar roomId={activeSnapshot.roomId} connection={activeSnapshot.connection} onLeave={() => void leave()} />
    <div className={styles.gameLayout}>
      <div className={styles.players}>
        <PlayerPanel player={activeSnapshot.players.B} active={activeSnapshot.turn === "B"} viewer={activeSnapshot.viewerSeat === "B"} />
        <PlayerPanel player={activeSnapshot.players.A} active={activeSnapshot.turn === "A"} viewer={activeSnapshot.viewerSeat === "A"} />
      </div>
      <main className={styles.boardColumn}>
        <h1 id="game-title">Bàn chơi <span className={styles.visuallyHidden}>BÃ n chÆ¡i</span></h1>
        <TurnStatus snapshot={activeSnapshot} />
        <div className={effectEventId !== null ? styles.effects : undefined} data-event-id={effectEventId ?? undefined}><Board session={session} snapshot={activeSnapshot} onError={onError} /></div>
      </main>
      <MoveHistory events={activeSnapshot.events} />
    </div>
    <ConfirmLeaveDialog open={confirmLeave} onCancel={() => setConfirmLeave(false)} onConfirm={() => void confirm()} />
    <ResultDialog open={resultOpen && activeSnapshot.phase === "finished"} result={activeSnapshot.result} viewerSeat={activeSnapshot.viewerSeat} playerNames={names} onClose={() => setResultOpen(false)} onLobby={onLobby} />
  </section>;
}
