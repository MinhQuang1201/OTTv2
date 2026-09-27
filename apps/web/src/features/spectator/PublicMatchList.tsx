import { useId } from "react";
import type { PublicMatchView } from "../../shared/model/game";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Spinner } from "../../shared/ui/Spinner";
import styles from "../lobby/lobby.module.css";

export type PublicMatchListState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly message?: string }
  | { readonly status: "error"; readonly message: string; readonly onRetry?: () => void }
  | { readonly status: "ready"; readonly matches: readonly PublicMatchView[] };

export type PublicMatchIdentity = Pick<PublicMatchView, "allocationId" | "roomId">;

export interface PublicMatchListProps {
  readonly state: PublicMatchListState;
  readonly onWatch: (identity: PublicMatchIdentity) => void;
  readonly disabled?: boolean;
  readonly headingId?: string;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSeat(value: unknown): value is "A" | "B" {
  return value === "A" || value === "B";
}

function normalizePlayer(value: unknown, seat: "A" | "B"):
  Pick<PublicMatchView["players"]["A"], "seat" | "name" | "connected" | "remainingMs"> | null {
  if (!isRecord(value) || value.seat !== seat || typeof value.name !== "string" || !value.name.trim() || typeof value.connected !== "boolean" || typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs < 0) return null;
  return { seat, name: value.name.trim(), connected: value.connected, remainingMs: value.remainingMs };
}

function normalizeMatch(value: unknown): PublicMatchView | null {
  if (!isRecord(value) || typeof value.allocationId !== "string" || typeof value.roomId !== "string" || value.status !== "playing" || !isRecord(value.players)) return null;
  const allocationId = value.allocationId.trim();
  const roomId = value.roomId.trim();
  const spectatorCount = value.spectatorCount;
  const serverNow = value.serverNow;
  const runningSeat = value.runningSeat;
  if (!allocationId || !roomId || !isNonnegativeInteger(spectatorCount) || !isFiniteNumber(serverNow) || (runningSeat !== null && !isSeat(runningSeat))) return null;
  const playerA = normalizePlayer(value.players.A, "A");
  const playerB = normalizePlayer(value.players.B, "B");
  if (!playerA || !playerB) return null;
  return {
    allocationId,
    roomId,
    status: "playing",
    players: { A: playerA, B: playerB },
    spectatorCount,
    serverNow,
    runningSeat,
  };
}

export function normalizePublicMatches(value: unknown): readonly PublicMatchView[] {
  if (!Array.isArray(value)) return [];
  const allocationIds = new Set<string>();
  const roomIds = new Set<string>();
  const normalized: PublicMatchView[] = [];
  for (const item of value) {
    const match = normalizeMatch(item);
    if (!match || allocationIds.has(match.allocationId) || roomIds.has(match.roomId)) continue;
    allocationIds.add(match.allocationId);
    roomIds.add(match.roomId);
    normalized.push(match);
  }
  return normalized;
}

function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function connectionLabel(connected: boolean): string {
  return connected ? "Đã kết nối" : "Mất kết nối";
}

export function PublicMatchList({ state, onWatch, disabled = false, headingId }: PublicMatchListProps) {
  const generatedHeadingId = useId().replace(/:/g, "");
  const resolvedHeadingId = headingId ?? `public-matches-title-${generatedHeadingId}`;
  const matches = state.status === "ready" ? normalizePublicMatches(state.matches) : [];
  return (
    <section className={[styles.roomList, styles.matchList].filter(Boolean).join(" ")} aria-labelledby={resolvedHeadingId} data-testid="public-match-list">
      <div className={styles.sectionHeading}>
        <h3 id={resolvedHeadingId}>Trận đang diễn ra</h3>
        {state.status === "ready" && matches.length > 0 ? <Badge status="info">{matches.length} trận</Badge> : null}
      </div>
      {state.status === "loading" ? (
        <div className={styles.roomState} role="status"><Spinner label="Đang tải trận đang diễn ra" /><span>Đang tải trận đang diễn ra…</span></div>
      ) : null}
      {state.status === "unavailable" ? <p className={styles.roomState}>{state.message ?? "Danh sách trận đang diễn ra hiện không khả dụng."}</p> : null}
      {state.status === "error" ? (
        <div className={styles.roomState} role="alert">
          <p>{state.message}</p>
          {state.onRetry ? <button className={styles.inlineButton} type="button" onClick={state.onRetry}>Thử lại</button> : null}
        </div>
      ) : null}
      {state.status === "ready" && matches.length === 0 ? <p className={styles.roomState}>Chưa có trận đang diễn ra.</p> : null}
      {state.status === "ready" && matches.length > 0 ? (
        <ul className={styles.matchItems}>
          {matches.map((match) => {
            const playerA = match.players.A;
            const playerB = match.players.B;
            return (
              <li key={match.allocationId} className={styles.matchItem}>
                <div className={styles.matchPlayers}>
                  <div className={styles.matchPlayer}>
                    <span className={styles.matchSeat} aria-label="Ghế A">A</span>
                    <div className={styles.matchPlayerIdentity}>
                      <strong>{playerA.name}</strong>
                      <span>{connectionLabel(playerA.connected)}</span>
                    </div>
                    <time className={styles.matchClock} dateTime={`PT${Math.max(0, Math.floor(playerA.remainingMs / 1000))}S`} aria-label={`Thời gian còn lại của ${playerA.name}: ${formatClock(playerA.remainingMs)}`}>
                      {formatClock(playerA.remainingMs)}
                    </time>
                  </div>
                  <span className={styles.matchVersus} aria-hidden="true">vs</span>
                  <div className={styles.matchPlayer}>
                    <span className={styles.matchSeat} aria-label="Ghế B">B</span>
                    <div className={styles.matchPlayerIdentity}>
                      <strong>{playerB.name}</strong>
                      <span>{connectionLabel(playerB.connected)}</span>
                    </div>
                    <time className={styles.matchClock} dateTime={`PT${Math.max(0, Math.floor(playerB.remainingMs / 1000))}S`} aria-label={`Thời gian còn lại của ${playerB.name}: ${formatClock(playerB.remainingMs)}`}>
                      {formatClock(playerB.remainingMs)}
                    </time>
                  </div>
                </div>
                <div className={styles.matchFooter}>
                  <span className={styles.roomItemMeta}>{match.spectatorCount} người xem</span>
                  <Button className={styles.matchWatchButton} variant="secondary" disabled={disabled} onClick={() => onWatch({ allocationId: match.allocationId, roomId: match.roomId })} aria-label={`Xem trận ${playerA.name} và ${playerB.name}`}>
                    Xem trận
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
