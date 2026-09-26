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
  const [effectEventId, setEffectEventId] = useState<number | null>(null);

  useEffect(() => {
    const latest = activeSnapshot.events.at(-1);
    if (!latest || latest.id <= highestEventId.current) return;
    highestEventId.current = latest.id;
    if (latest.type === "capture" || latest.type === "strike_loss" || latest.type === "win") {
      setEffectEventId(latest.id);
      const timer = window.setTimeout(() => setEffectEventId((current) => current === latest.id ? null : current), 240);
      return () => window.clearTimeout(timer);
    }
  }, [activeSnapshot.events]);

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
