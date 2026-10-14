import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { TextField } from "../../shared/ui/TextField";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import { ModeCard } from "./ModeCard";
import { OnlineRoomPanel, type OnlineAvailability } from "./OnlineRoomPanel";
import { readPlayerName, writePlayerName } from "./playerNameStorage";
import { type WaitingRoomState } from "./WaitingRoomList";
import type { PublicMatchIdentity, PublicMatchListState } from "../spectator/PublicMatchList";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { parseReplayFile } from "../replay/replayImport";
import { getGameCoreBridge } from "../../sessions/core/gameCoreBridge";
import { normalizeCoreState } from "../../sessions/core/normalizeCoreState";
import type { PieceType, Seat } from "../../shared/model/game";
import styles from "./lobby.module.css";

interface MiniBoardState {
  readonly goalA: { readonly x: number; readonly y: number };
  readonly goalB: { readonly x: number; readonly y: number };
  readonly pieceMap: ReadonlyMap<string, { readonly seat: Seat; readonly type: PieceType }>;
}

function getInitialMiniBoard(): MiniBoardState {
  try {
    const bridge = getGameCoreBridge();
    const coreState = bridge.createInitialState();
    const snapshot = normalizeCoreState(coreState);
    const pieceMap = new Map<string, { readonly seat: Seat; readonly type: PieceType }>();
    for (const piece of snapshot.board) {
      pieceMap.set(`${piece.position.x}:${piece.position.y}`, {
        seat: piece.seat,
        type: piece.type,
      });
    }
    return {
      goalA: bridge.config.GOAL.A,
      goalB: bridge.config.GOAL.B,
      pieceMap,
    };
  } catch {
    return {
      goalA: { x: 0, y: 0 },
      goalB: { x: 8, y: 8 },
      pieceMap: new Map(),
    };
  }
}

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
  readonly onOpenArena?: () => void;
  readonly arenaAvailable?: boolean;
  readonly allowDemoWatch?: boolean;
}

export function LobbyScreen({
  onlineAvailability,
  waitingRooms,
  publicMatches,
  onStartLocal,
  onStartAi,
  onCreateOnline,
  onJoinOnline,
  onWatchMatch,
  onStartReplay,
  onOpenArena,
  arenaAvailable,
  allowDemoWatch,
}: LobbyScreenProps) {
  const [playerName, setPlayerName] = useState("");
  const [playerNameError, setPlayerNameError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importGenerationRef = useRef(0);
  const miniBoardState = useMemo(() => getInitialMiniBoard(), []);

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
        <div className={styles.eyebrow}>
          <PixelSprite kind="trophy" size={14} decorative />
          <span>Bàn 9×9 · Đấm · Lá · Kéo</span>
        </div>
        <h1 id="lobby-title">OTTv2</h1>
        <p className={styles.lede}>
          Đưa quân của bạn vào ô thắng hoặc ăn hết quân đối phương. Mỗi nước đi là một quyết định ngắn, rõ ràng.
        </p>

        <div className={styles.seasonBanner} aria-hidden="true">
          <div className={styles.seasonTag}>
            <PixelSprite kind="flag" size={14} seat="A" decorative />
            <span>CHIẾN THUẬT 9×9</span>
          </div>
          <span className={styles.seasonDetail}>Lượt đi đối kháng · Trọng tài chuẩn xác</span>
        </div>

        <div className={styles.ruleLoop} aria-label="Vòng khắc chế">
          <span className={styles.rulePill}>
            <PixelSprite kind="dam" size={16} decorative />
            <span>Đấm</span>
          </span>
          <span aria-hidden="true" className={styles.ruleArrow}>›</span>
          <span className={styles.rulePill}>
            <PixelSprite kind="keo" size={16} decorative />
            <span>Kéo</span>
          </span>
          <span aria-hidden="true" className={styles.ruleArrow}>›</span>
          <span className={styles.rulePill}>
            <PixelSprite kind="la" size={16} decorative />
            <span>Lá</span>
          </span>
          <span aria-hidden="true" className={styles.ruleArrow}>›</span>
          <span className={styles.rulePill}>
            <PixelSprite kind="dam" size={16} decorative />
            <span>Đấm</span>
          </span>
        </div>

        <div className={styles.miniBoard} aria-hidden="true">
          {Array.from({ length: 81 }, (_, index) => {
            const x = index % 9;
            const y = Math.floor(index / 9);
            const isGoalA = x === miniBoardState.goalA.x && y === miniBoardState.goalA.y;
            const isGoalB = x === miniBoardState.goalB.x && y === miniBoardState.goalB.y;
            const piece = miniBoardState.pieceMap.get(`${x}:${y}`);
            const isLight = (x + y) % 2 === 0;
            return (
              <span
                key={`${x}:${y}`}
                className={[
                  styles.miniCell,
                  isLight ? styles.miniLight : styles.miniDark,
                  isGoalA ? styles.miniGoalA : "",
                  isGoalB ? styles.miniGoalB : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-coord={`${x}:${y}`}
              >
                {piece ? (
                  <PixelSprite
                    kind={piece.type}
                    seat={piece.seat}
                    size={14}
                    decorative
                    className={styles.miniPieceSprite}
                  />
                ) : isGoalA ? (
                  <PixelSprite kind="flag" seat="A" size={14} decorative className={styles.miniFlag} />
                ) : isGoalB ? (
                  <PixelSprite kind="flag" seat="B" size={14} decorative className={styles.miniFlag} />
                ) : null}
              </span>
            );
          })}
        </div>
        <p className={styles.ruleNote}>
          Đi như vua. Không đứng chung ô với cùng loại quân đối phương. Hai góc đối diện là ô thắng.
        </p>
      </div>

      <div className={styles.lobbyActions}>
        <Panel className={styles.quickPanel} heading="Bắt đầu ván mới">
          <TextField
            label="Tên của bạn"
            value={playerName}
            error={playerNameError ?? undefined}
            onChange={(event) => updateName(event.currentTarget.value)}
            placeholder="Nhập tên"
            autoComplete="nickname"
          />
          <div className={styles.modeList}>
            <ModeCard
              title="Cùng máy"
              description="Hai người chơi luân phiên trên một thiết bị."
              actionLabel="Chơi cùng máy"
              icon={<PixelSprite kind="dam" size={24} seat="A" decorative />}
              onSelect={() => handleStartLocal([normalizedName, "Đối thủ"])}
            />
            <ModeCard
              title="Đấu với AI"
              description="Bạn đi trước, AI phản hồi sau mỗi nước hợp lệ."
              actionLabel="Đánh với AI"
              variant="primary"
              icon={<PixelSprite kind="bot" size={24} decorative />}
              onSelect={() => handleStartAi(normalizedName)}
            />
            {onStartReplay && (
              <ModeCard
                title="Xem lại trận đấu"
                description="Mở tập tin replay JSON để xem lại từng nước đi của trận đấu Arena."
                actionLabel="Mở file Replay"
                icon={<PixelSprite kind="trophy" size={24} decorative />}
                onSelect={() => fileInputRef.current?.click()}
              />
            )}
            {onOpenArena && arenaAvailable && (
              <ModeCard
                title="Đấu trường AI"
                description="Xem bảng xếp hạng, giải đấu và theo dõi trận đấu bot."
                actionLabel="Vào đấu trường"
                icon={<PixelSprite kind="flag" size={24} seat="B" decorative />}
                onSelect={() => {
                  importGenerationRef.current += 1;
                  onOpenArena();
                }}
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
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setImportError(null);
                      fileInputRef.current?.click();
                    }}
                  >
                    Thử lại
                  </Button>
                </div>
              )}
            </>
          )}
        </Panel>

        <OnlineRoomPanel
          availability={onlineAvailability}
          waitingRooms={waitingRooms}
          publicMatches={publicMatches}
          playerName={playerName}
          onPlayerNameChange={updateName}
          showNameField={false}
          onCreate={createOnline}
          onJoin={joinOnline}
          onWatch={onWatchMatch}
          allowDemoWatch={allowDemoWatch}
        />
      </div>
    </section>
  );
}

export function LobbyHeaderAction({ onClick }: { readonly onClick: () => void }) {
  return <Button variant="quiet" onClick={onClick}>Sảnh</Button>;
}
