import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import { ModeCard } from "./ModeCard";
import { OnlineRoomPanel, type OnlineAvailability } from "./OnlineRoomPanel";
import { readPlayerName, writePlayerName } from "./playerNameStorage";
import { type WaitingRoomState } from "./WaitingRoomList";
import styles from "./lobby.module.css";

export interface LobbyScreenProps {
  readonly onlineAvailability: OnlineAvailability;
  readonly waitingRooms: WaitingRoomState;
  readonly onStartLocal: (names: [string, string]) => void;
  readonly onStartAi: (playerName: string) => void;
  readonly onCreateOnline: (playerName: string) => void;
  readonly onJoinOnline: (playerName: string, roomId: string) => void;
}

export function LobbyScreen({ onlineAvailability, waitingRooms, onStartLocal, onStartAi, onCreateOnline, onJoinOnline }: LobbyScreenProps) {
  const [playerName, setPlayerName] = useState("");
  useEffect(() => setPlayerName(readPlayerName()), []);
  const updateName = (value: string) => {
    setPlayerName(value);
    writePlayerName(value);
  };
  const normalizedName = playerName.trim();

  return (
    <section className={styles.lobby} aria-labelledby="lobby-title">
      <div className={styles.lobbyIntro}>
        <div className={styles.eyebrow}>Bàn 9×9 · Đấm · Lá · Kéo</div>
        <h1 id="lobby-title">OTTv2</h1>
        <p className={styles.lede}>Đưa quân của bạn vào ô thắng hoặc ăn hết quân đối phương. Mỗi nước đi là một quyết định ngắn, rõ ràng.</p>
        <div className={styles.ruleLoop} aria-label="Vòng khắc chế">
          <span>Đấm</span><span aria-hidden="true">›</span><span>Kéo</span><span aria-hidden="true">›</span><span>Lá</span><span aria-hidden="true">›</span><span>Đấm</span>
        </div>
        <div className={styles.miniBoard} aria-hidden="true">
          {Array.from({ length: 81 }, (_, index) => <span key={index} className={[styles.miniCell, index === 0 ? styles.miniGoalA : "", index === 80 ? styles.miniGoalB : "", index % 9 === 0 ? styles.miniPiece : ""].filter(Boolean).join(" ")} />)}
        </div>
        <p className={styles.ruleNote}>Đi như vua. Không đứng chung ô với cùng loại quân đối phương. Hai góc đối diện là ô thắng.</p>
      </div>
      <div className={styles.lobbyActions}>
        <Panel className={styles.quickPanel} heading="Bắt đầu ván mới">
          <TextField label="Tên của bạn" value={playerName} onChange={(event) => updateName(event.currentTarget.value)} placeholder="Nhập tên" autoComplete="nickname" />
          <div className={styles.modeList}>
            <ModeCard title="Cùng máy" description="Hai người chơi luân phiên trên một thiết bị." actionLabel="Chơi cùng máy" onSelect={() => onStartLocal([normalizedName, "Đối thủ"])} />
            <ModeCard title="Đấu với AI" description="Bạn đi trước, AI phản hồi sau mỗi nước hợp lệ." actionLabel="Đánh với AI" variant="primary" onSelect={() => onStartAi(normalizedName)} />
          </div>
        </Panel>
        <OnlineRoomPanel availability={onlineAvailability} waitingRooms={waitingRooms} playerName={playerName} onPlayerNameChange={updateName} showNameField={false} onCreate={onCreateOnline} onJoin={onJoinOnline} />
      </div>
    </section>
  );
}

export function LobbyHeaderAction({ onClick }: { readonly onClick: () => void }) {
  return <Button variant="quiet" onClick={onClick}>Sảnh</Button>;
}

