import { useEffect, useState } from "react";
import type { GameSession, ReplayPlaybackFacade, ReplayPlaybackView } from "../../sessions/contract";
import type { GameSnapshot } from "../../shared/model/game";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { useSessionSnapshot } from "../../sessions/useSessionSnapshot";
import { INITIAL_PLAYBACK_VIEW } from "../../sessions/replay/ReplaySession";
import { Board } from "../game/Board";
import { PlayerPanel } from "../game/PlayerPanel";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { ReplayControls } from "./ReplayControls";
import { ArenaResultSummary } from "./ArenaResultSummary";
import { downloadReplayDocument } from "./replayImport";
import styles from "./replay.module.css";

export interface ReplayScreenProps {
  readonly session: GameSession & Partial<ReplayPlaybackFacade> & {
    readonly getDocument?: () => ReplayDocument | null;
  };
  readonly snapshot: GameSnapshot;
  readonly onLobby: () => void;
  readonly initialDocument?: ReplayDocument;
}

export function ReplayScreen({
  session,
  snapshot: initialSnapshot,
  onLobby,
  initialDocument,
}: ReplayScreenProps) {
  const activeSnapshot = useSessionSnapshot(session) || initialSnapshot;

  const [playback, setPlayback] = useState<ReplayPlaybackView>(() => {
    return session.getPlayback ? session.getPlayback() : INITIAL_PLAYBACK_VIEW;
  });

  const [summaryDismissed, setSummaryDismissed] = useState(false);

  useEffect(() => {
    if (session.getPlayback) {
      setPlayback(session.getPlayback());
      return session.subscribe(() => {
        setPlayback(session.getPlayback!());
      });
    }
  }, [session]);

  // When cursor changes away from terminal, reset dismissal
  useEffect(() => {
    if (!playback.isAtEnd) {
      setSummaryDismissed(false);
    }
  }, [playback.isAtEnd, playback.cursor]);

  const handleSeek = (cursor: number) => {
    session.seek?.(cursor);
  };

  const handlePlay = () => {
    session.play?.();
  };

  const handlePause = () => {
    session.pause?.();
  };

  const handleStep = (direction: "next" | "prev") => {
    session.step?.(direction);
  };

  const handleSetSpeed = (speed: import("../../sessions/contract").ReplaySpeed) => {
    session.setSpeed?.(speed);
  };

  const handleExport = () => {
    const doc = session.getDocument?.() || initialDocument;
    if (doc) {
      downloadReplayDocument(doc);
    }
  };

  const highlightMove = playback.lastMove
    ? { from: playback.lastMove.from, to: playback.lastMove.to }
    : null;

  const showResultOverlay = playback.isAtEnd && Boolean(playback.result) && !summaryDismissed;

  const doc = session.getDocument?.() || initialDocument;

  const renderParticipantMeta = (seat: "A" | "B") => {
    const p = doc?.participants?.[seat] || playback.participants?.[seat];
    if (!p) return null;
    const displayName = p.name || p.botId;
    const versionPart = p.botVersionId ? ` (v${p.botVersionId})` : "";
    const profilePart = p.profileId ? ` · [${p.profileId}]` : "";
    return `${displayName}${versionPart}${profilePart}`;
  };

  return (
    <div className={styles.replayScreen}>
      <header className={styles.topBar}>
        <div>
          <span className={styles.kicker}>Chế độ Replay Arena</span>
          <h1 className={styles.topBarTitle}>Xem lại trận đấu</h1>
        </div>
        <div className={styles.topBarActions}>
          {doc && (
            <Button
              variant="secondary"
              onClick={handleExport}
              aria-label="Tải về tập tin replay JSON"
              data-testid="replay-export-btn"
            >
              Tải Replay
            </Button>
          )}
          {playback.isAtEnd && playback.result && summaryDismissed && (
            <Button
              variant="secondary"
              onClick={() => setSummaryDismissed(false)}
              aria-label="Xem lại bảng kết quả"
            >
              Xem kết quả
            </Button>
          )}
          <Button
            variant="quiet"
            onClick={onLobby}
            aria-label="Trở về sảnh"
            data-testid="replay-lobby-btn"
          >
            Về sảnh
          </Button>
        </div>
      </header>

      <div className={styles.replayLayout}>
        <div className={styles.playersRail}>
          <PlayerPanel
            player={activeSnapshot.players.A}
            active={activeSnapshot.turn === "A"}
            viewer={false}
            spectator={true}
          />
          <PlayerPanel
            player={activeSnapshot.players.B}
            active={activeSnapshot.turn === "B"}
            viewer={false}
            spectator={true}
          />
        </div>

        <div className={styles.boardContainer}>
          <Board
            session={session}
            snapshot={activeSnapshot}
            highlightMove={highlightMove}
          />
          <ReplayControls
            playback={playback}
            onSeek={handleSeek}
            onPlay={handlePlay}
            onPause={handlePause}
            onStep={handleStep}
            onSetSpeed={handleSetSpeed}
          />
        </div>

        <aside className={styles.sideRail}>
          <Panel heading="Thông tin trận đấu">
            <dl className={styles.resultMeta} data-testid="replay-metadata">
              <dt>Trạng thái</dt>
              <dd>{playback.isAtEnd ? "Kết thúc" : playback.isPlaying ? "Đang phát" : "Tạm dừng"}</dd>
              <dt>Nước hiện tại</dt>
              <dd>{playback.cursor} / {playback.totalPlies}</dd>
              {doc?.matchId && (
                <>
                  <dt>Mã trận đấu</dt>
                  <dd data-testid="meta-match-id">{doc.matchId}</dd>
                </>
              )}
              {doc?.rulesetId && (
                <>
                  <dt>Bộ luật</dt>
                  <dd data-testid="meta-ruleset-id">{doc.rulesetId}</dd>
                </>
              )}
              {doc?.engineRevision && (
                <>
                  <dt>Phiên bản engine</dt>
                  <dd data-testid="meta-engine-revision">{doc.engineRevision}</dd>
                </>
              )}
              {(doc?.participants?.A || playback.participants?.A) && (
                <>
                  <dt>Đấu thủ A</dt>
                  <dd data-testid="meta-participant-a">{renderParticipantMeta("A")}</dd>
                </>
              )}
              {(doc?.participants?.B || playback.participants?.B) && (
                <>
                  <dt>Đấu thủ B</dt>
                  <dd data-testid="meta-participant-b">{renderParticipantMeta("B")}</dd>
                </>
              )}
              {playback.lastMove && (
                <>
                  <dt>Nước vừa đi</dt>
                  <dd>
                    Bên {playback.lastMove.seat}: ({playback.lastMove.from.x},{playback.lastMove.from.y}) → ({playback.lastMove.to.x},{playback.lastMove.to.y})
                  </dd>
                </>
              )}
            </dl>
          </Panel>
        </aside>
      </div>

      {showResultOverlay && playback.result && (
        <ArenaResultSummary
          result={playback.result}
          participants={playback.participants}
          onLobby={onLobby}
          onClose={() => setSummaryDismissed(true)}
        />
      )}
    </div>
  );
}
