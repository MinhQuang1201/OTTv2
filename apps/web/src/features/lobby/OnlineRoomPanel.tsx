import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import styles from "./lobby.module.css";
import { WaitingRoomList, type WaitingRoomState } from "./WaitingRoomList";

export type OnlineAvailability = "online" | "connecting" | "unavailable";

export interface OnlineRoomPanelProps {
  readonly availability: OnlineAvailability;
  readonly waitingRooms?: WaitingRoomState;
  readonly playerName?: string;
  readonly onPlayerNameChange?: (value: string) => void;
  readonly showNameField?: boolean;
  readonly onCreate: (playerName: string) => void;
  readonly onJoin: (playerName: string, roomId: string) => void;
  readonly onRetryRooms?: () => void;
}

export function OnlineRoomPanel({
  availability,
  waitingRooms = { status: "ready", rooms: [] },
  playerName: controlledName,
  onPlayerNameChange,
  showNameField = true,
  onCreate,
  onJoin,
  onRetryRooms,
}: OnlineRoomPanelProps) {
  const [uncontrolledName, setUncontrolledName] = useState(controlledName ?? "");
  const [roomId, setRoomId] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const name = controlledName ?? uncontrolledName;
  const isReady = availability === "online";

  useEffect(() => {
    if (controlledName !== undefined) setUncontrolledName(controlledName);
  }, [controlledName]);

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
      {availability === "unavailable" ? <p className={styles.unavailableCopy}>Bạn có thể bắt đầu ván local hoặc đấu với AI ngay.</p> : null}
      <div className={styles.onlineActions}>
        <Button disabled={!isReady} onClick={create}>Tạo phòng</Button>
        <div className={styles.joinRow}>
          <TextField label="Mã phòng" value={roomId} onChange={(event) => { setRoomId(event.currentTarget.value); if (roomError) setRoomError(null); }} error={roomError ?? undefined} placeholder="Ví dụ: room-7" autoComplete="off" />
          <Button variant="secondary" disabled={!isReady} onClick={join}>Vào phòng</Button>
        </div>
      </div>
      <WaitingRoomList
        state={waitingRooms.status === "error" && !waitingRooms.onRetry && onRetryRooms ? { ...waitingRooms, onRetry: onRetryRooms } : waitingRooms}
        disabled={!isReady}
        onSelectRoom={(selectedRoomId) => { setRoomId(selectedRoomId); setRoomError(null); onJoin(name.trim(), selectedRoomId); }}
      />
    </Panel>
  );
}
