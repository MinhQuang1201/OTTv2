import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import styles from "./lobby.module.css";
import { WaitingRoomList, type WaitingRoomState } from "./WaitingRoomList";
import { PublicMatchList, type PublicMatchIdentity, type PublicMatchListState } from "../spectator/PublicMatchList";

export type OnlineAvailability = "online" | "connecting" | "unavailable";

/** An unfinished online game this browser can re-enter. */
export interface PendingGameView {
  readonly alias: string | null;
  readonly seat: "A" | "B";
}

/** Top-of-lobby card offering to re-enter an unfinished online game after a reload or a closed tab. */
export function PendingGameCard({ game, ready, onResume, onDiscard }: {
  readonly game: PendingGameView;
  readonly ready: boolean;
  readonly onResume: () => void;
  readonly onDiscard?: () => void;
}) {
  return (
    <div className={styles.resumeCard} role="region" aria-label="Ván online đang dở">
      <div>
        <strong>Bạn đang có ván dở</strong>
        <p>{game.alias ? `Phòng ${game.alias} · ` : ""}bạn là {game.seat === "A" ? "Đỏ (A)" : "Xanh (B)"}</p>
      </div>
      <div className={styles.resumeActions}>
        <Button disabled={!ready} onClick={onResume}>Vào lại</Button>
        {onDiscard ? <Button variant="quiet" onClick={onDiscard}>Bỏ</Button> : null}
      </div>
    </div>
  );
}

export interface OnlineRoomPanelProps {
  readonly availability: OnlineAvailability;
  readonly waitingRooms?: WaitingRoomState;
  readonly publicMatches?: PublicMatchListState;
  readonly playerName?: string;
  readonly onPlayerNameChange?: (value: string) => void;
  readonly showNameField?: boolean;
  readonly onCreate: (playerName: string) => void;
  readonly onJoin: (playerName: string, roomId: string) => void;
  readonly onWatch?: (identity: PublicMatchIdentity) => void;
  readonly onRetryRooms?: () => void;
  readonly allowDemoWatch?: boolean;
  /** Room code from an invite link (`?join=`), pre-filled into the join field. */
  readonly initialRoomCode?: string;
  /** Lets the player abandon a connection attempt instead of waiting on it. */
  readonly onCancelConnecting?: () => void;
}

export function OnlineRoomPanel({
  availability,
  waitingRooms = { status: "ready", rooms: [] },
  publicMatches = { status: "unavailable", message: "Danh sách trận đang diễn ra hiện không khả dụng." },
  playerName: controlledName,
  onPlayerNameChange,
  showNameField = true,
  onCreate,
  onJoin,
  onWatch = () => undefined,
  onRetryRooms,
  allowDemoWatch = false,
  initialRoomCode,
  onCancelConnecting,
}: OnlineRoomPanelProps) {
  const [uncontrolledName, setUncontrolledName] = useState(controlledName ?? "");
  const [roomId, setRoomId] = useState(initialRoomCode ?? "");
  const [roomError, setRoomError] = useState<string | null>(null);
  const name = controlledName ?? uncontrolledName;
  const isReady = availability === "online";
  const canWatchMatches = isReady || allowDemoWatch;

  useEffect(() => {
    if (controlledName !== undefined) setUncontrolledName(controlledName);
  }, [controlledName]);

  useEffect(() => {
    if (initialRoomCode) setRoomId(initialRoomCode);
  }, [initialRoomCode]);

  const updateName = (value: string) => {
    if (controlledName === undefined) setUncontrolledName(value);
    onPlayerNameChange?.(value);
  };
  const create = () => onCreate(name.trim());
  const join = () => {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      setRoomError("Nhập mã phòng để tham gia.");
      return;
    }
    setRoomError(null);
    onJoin(name.trim(), normalizedRoomId);
  };

  return (
    <Panel className={styles.onlinePanel} heading="Chơi online">
      <p className={styles.panelIntro}>Tạo một phòng hoặc chọn phòng đang chờ. Khi online chưa sẵn sàng, bạn vẫn có thể chơi cùng máy hoặc với AI.</p>
      {showNameField ? <TextField label="Tên của bạn" value={name} onChange={(event) => updateName(event.currentTarget.value)} placeholder="Nhập tên" autoComplete="nickname" /> : null}
      <div className={styles.onlineStatus} role="status" aria-live="polite">
        <span className={[styles.statusDot, styles[`status${availability}`]].join(" ")} aria-hidden="true" />
        {availability === "online" ? "Online sẵn sàng" : availability === "connecting" ? "Đang kết nối online…" : "Online hiện không khả dụng"}
      </div>
      {availability === "connecting" && onCancelConnecting ? (
        <Button variant="quiet" onClick={onCancelConnecting}>Huỷ kết nối</Button>
      ) : null}

      {availability === "unavailable" ? <p className={styles.unavailableCopy}>Bạn có thể bắt đầu ván local hoặc đấu với AI ngay.</p> : null}
      <div className={styles.onlineActions}>
        <Button disabled={!isReady} onClick={create}>Tạo phòng</Button>
        <div className={styles.joinRow}>
          <TextField label="Mã phòng" value={roomId} onChange={(event) => { setRoomId(event.currentTarget.value); if (roomError) setRoomError(null); }} error={roomError ?? undefined} placeholder="Ví dụ: K7N-M4P hoặc link mời" autoComplete="off" />
          <Button variant="secondary" disabled={!isReady} onClick={join}>Vào phòng</Button>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--ui-text-muted, #888)" }}>
          Nhập mã phòng ngắn (như K7N-M4P), dán link mời, hoặc mã lời mời giải đấu (inv_...).
        </p>
      </div>
      <WaitingRoomList
        state={waitingRooms.status === "error" && !waitingRooms.onRetry && onRetryRooms ? { ...waitingRooms, onRetry: onRetryRooms } : waitingRooms}
        disabled={!isReady}
        onSelectRoom={(selectedRoomId) => { setRoomId(selectedRoomId); setRoomError(null); onJoin(name.trim(), selectedRoomId); }}
      />
      <PublicMatchList state={publicMatches} disabled={!canWatchMatches} onWatch={onWatch} />
    </Panel>
  );
}
