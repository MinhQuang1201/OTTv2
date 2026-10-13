import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import { ModeCard } from "./ModeCard";
import { OnlineRoomPanel, type OnlineAvailability } from "./OnlineRoomPanel";
import { readPlayerName, writePlayerName } from "./playerNameStorage";
import { type WaitingRoomState } from "./WaitingRoomList";
import type { PublicMatchIdentity, PublicMatchListState } from "../spectator/PublicMatchList";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { parseReplayFile } from "../replay/replayImport";
import styles from "./lobby.module.css";

export interface LobbyScreenProps {
  readonly onlineAvailability: OnlineAvailability;
  readonly waitingRooms: WaitingRoomState;
  readonly publicMatches?: PublicMatchListState;
  readonly onStartLocal: (names: [string, string]) => void;
  readonly onStartAi: (playerName: string) => void;
  readonly onCreateOnline: (playerName: string) => void;
  readonly onJoinOnline: (playerName: string, roomId: string) => void;
  readonly onWatchMatch?: (identity: PublicMatchIdentity) => void;
  readonly onStartReplay?: (document: ReplayDocument) => void;
  readonly allowDemoWatch?: boolean;
}

export function LobbyScreen({ onlineAvailability, waitingRooms, publicMatches, onStartLocal, onStartAi, onCreateOnline, onJoinOnline, onWatchMatch, onStartReplay, allowDemoWatch }: LobbyScreenProps) {
  const [playerName, setPlayerName] = useState("");
  const [playerNameError, setPlayerNameError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importGenerationRef = useRef(0);

  useEffect(() => setPlayerName(readPlayerName()), []);
  useEffect(() => {
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const updateName = (value: string) => {
    setPlayerName(value);
    if (playerNameError) setPlayerNameError(null);
    writePlayerName(value);
  };
  const normalizedName = playerName.trim();
  const createOnline = () => {
    importGenerationRef.current += 1;
    if (!normalizedName) {
      setPlayerNameError("Nhập tên của bạn để tạo phòng online.");
      return;
    }
    onCreateOnline(normalizedName);
  };
  const joinOnline = (name: string, roomId: string) => {
    importGenerationRef.current += 1;
    if (!name.trim()) {
      setPlayerNameError("Nhập tên của bạn để vào phòng online.");
      return;
    }
    onJoinOnline(name, roomId);
  };
  const handleStartLocal = (names: [string, string]) => {
    importGenerationRef.current += 1;
    onStartLocal(names);
  };
  const handleStartAi = (name: string) => {
    importGenerationRef.current += 1;
    onStartAi(name);
  };
  const handleReplayFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const generation = ++importGenerationRef.current;
    setImportError(null);
    event.target.value = "";
    const result = await parseReplayFile(file);
    if (generation !== importGenerationRef.current) {
      return;
    }
    if (result.ok) {
      onStartReplay?.(result.document);
    } else {
      setImportError(result.error);
    }
  };

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
          <TextField label="Tên của bạn" value={playerName} error={playerNameError ?? undefined} onChange={(event) => updateName(event.currentTarget.value)} placeholder="Nhập tên" autoComplete="nickname" />
          <div className={styles.modeList}>
            <ModeCard title="Cùng máy" description="Hai người chơi luân phiên trên một thiết bị." actionLabel="Chơi cùng máy" onSelect={() => handleStartLocal([normalizedName, "Đối thủ"])} />
            <ModeCard title="Đấu với AI" description="Bạn đi trước, AI phản hồi sau mỗi nước hợp lệ." actionLabel="Đánh với AI" variant="primary" onSelect={() => handleStartAi(normalizedName)} />
            {onStartReplay && (
              <ModeCard
                title="Xem lại trận đấu"
                description="Mở tập tin replay JSON để xem lại từng nước đi của trận đấu Arena."
                actionLabel="Mở file Replay"
                onSelect={() => fileInputRef.current?.click()}
              />
            )}
          </div>
          {onStartReplay && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                aria-label="Chọn tập tin replay JSON"
                data-testid="lobby-replay-file-input"
                style={{ display: "none" }}
                onChange={handleReplayFile}
              />
              {importError && (
                <div role="alert" className={styles.replayError} data-testid="lobby-replay-error">
                  <span>{importError}</span>
                  <Button variant="quiet" onClick={() => { setImportError(null); fileInputRef.current?.click(); }}>
                    Thử lại
                  </Button>
                </div>
              )}
            </>
          )}
        </Panel>
        <OnlineRoomPanel availability={onlineAvailability} waitingRooms={waitingRooms} publicMatches={publicMatches} playerName={playerName} onPlayerNameChange={updateName} showNameField={false} onCreate={createOnline} onJoin={joinOnline} onWatch={onWatchMatch} allowDemoWatch={allowDemoWatch} />
      </div>
    </section>
  );
}

export function LobbyHeaderAction({ onClick }: { readonly onClick: () => void }) {
  return <Button variant="quiet" onClick={onClick}>Sảnh</Button>;
}

