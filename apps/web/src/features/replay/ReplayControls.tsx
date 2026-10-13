import type { ReplayPlaybackView, ReplaySpeed } from "../../sessions/contract";
import { Button } from "../../shared/ui/Button";
import styles from "./replay.module.css";

export interface ReplayControlsProps {
  readonly playback: ReplayPlaybackView;
  readonly onSeek: (cursor: number) => void;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onStep: (direction: "next" | "prev") => void;
  readonly onSetSpeed: (speed: ReplaySpeed) => void;
}

const SPEEDS: readonly ReplaySpeed[] = [0.5, 1, 2, 4];

export function ReplayControls({
  playback,
  onSeek,
  onPlay,
  onPause,
  onStep,
  onSetSpeed,
}: ReplayControlsProps) {
  const { cursor, totalPlies, isPlaying, speed, isAtStart, isAtEnd } = playback;

  return (
    <section className={styles.replayControls} aria-label="Bảng điều khiển xem lại trận đấu">
      <div className={styles.timelineRow}>
        <div className={styles.timelineHeader}>
          <label htmlFor="replay-timeline-slider" className={styles.timelineLabel}>
            Tiến trình trận đấu
          </label>
          <span className={styles.plyIndicator} aria-live="polite" data-testid="replay-ply-indicator">
            {`Nước ${cursor} trên ${totalPlies}`}
          </span>
        </div>

        <input
          id="replay-timeline-slider"
          type="range"
          min={0}
          max={totalPlies}
          value={cursor}
          onChange={(event) => onSeek(Number(event.target.value))}
          className={styles.timelineSlider}
          aria-label="Thanh thời gian nước đi"
          aria-valuenow={cursor}
          aria-valuemin={0}
          aria-valuemax={totalPlies}
          aria-valuetext={`Nước ${cursor} trên ${totalPlies}`}
          data-testid="replay-timeline-slider"
        />
      </div>

      <div className={styles.buttonRow}>
        <div className={styles.playbackButtons}>
          <Button
            variant="secondary"
            onClick={() => onStep("prev")}
            disabled={isAtStart}
            aria-label="Lùi 1 nước"
            data-testid="replay-step-prev-btn"
          >
            ‹ Lùi
          </Button>

          <Button
            variant={isPlaying ? "secondary" : "primary"}
            onClick={isPlaying ? onPause : onPlay}
            aria-label={isPlaying ? "Tạm dừng" : "Phát lại"}
            data-testid="replay-play-pause-btn"
          >
            {isPlaying ? "Tạm dừng" : "Phát"}
          </Button>

          <Button
            variant="secondary"
            onClick={() => onStep("next")}
            disabled={isAtEnd}
            aria-label="Tiến 1 nước"
            data-testid="replay-step-next-btn"
          >
            Tiến ›
          </Button>
        </div>

        <div className={styles.speedSelector} role="group" aria-label="Tốc độ phát">
          <span className={styles.speedLabel} id="speed-group-label" aria-hidden="true">Tốc độ:</span>
          {SPEEDS.map((s) => (
            <Button
              key={s}
              variant={speed === s ? "primary" : "quiet"}
              onClick={() => onSetSpeed(s)}
              aria-pressed={speed === s}
              aria-label={`Tốc độ ${s}x`}
              data-testid={`replay-speed-${s}`}
              className={speed === s ? styles.speedActive : undefined}
            >
              {s}x
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
