import type { WaitingRoomView } from "../../shared/model/game";
import { Badge } from "../../shared/ui/Badge";
import { Spinner } from "../../shared/ui/Spinner";
import styles from "./lobby.module.css";

export type WaitingRoomState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly message?: string }
  | { readonly status: "error"; readonly message: string; readonly onRetry?: () => void }
  | { readonly status: "ready"; readonly rooms: readonly WaitingRoomView[] };

export interface WaitingRoomListProps {
  readonly state: WaitingRoomState;
  readonly onSelectRoom: (roomId: string) => void;
}

export function WaitingRoomList({ state, onSelectRoom }: WaitingRoomListProps) {
  return (
    <section className={styles.roomList} aria-labelledby="waiting-rooms-title">
      <div className={styles.sectionHeading}>
        <h3 id="waiting-rooms-title">Phòng đang chờ</h3>
        {state.status === "ready" && state.rooms.length > 0 ? <Badge status="info">{state.rooms.length} phòng</Badge> : null}
      </div>
      {state.status === "loading" ? (
        <div className={styles.roomState} role="status"><Spinner label="Đang tải phòng chờ" /><span>Đang tải phòng chờ…</span></div>
      ) : null}
      {state.status === "unavailable" ? <p className={styles.roomState}>{state.message ?? "Online hiện không khả dụng."}</p> : null}
      {state.status === "error" ? (
        <div className={styles.roomState} role="alert">
          <p>{state.message}</p>
          {state.onRetry ? <button className={styles.inlineButton} type="button" onClick={state.onRetry}>Thử lại</button> : null}
        </div>
      ) : null}
      {state.status === "ready" && state.rooms.length === 0 ? <p className={styles.roomState}>Chưa có phòng chờ. Bạn có thể tạo phòng mới.</p> : null}
      {state.status === "ready" && state.rooms.length > 0 ? (
        <ul className={styles.roomItems}>
          {state.rooms.map((room) => {
            const full = room.playerCount >= room.maxPlayers;
            return (
              <li key={room.roomId}>
                <button className={styles.roomItem} type="button" disabled={full} onClick={() => onSelectRoom(room.roomId)}>
                  <span className={styles.roomItemMain}>
                    <strong>{room.roomId}</strong>
                    <span>{room.hostName}</span>
                  </span>
                  <span className={styles.roomItemMeta}>{room.playerCount}/{room.maxPlayers} người</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

