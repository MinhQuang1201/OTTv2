import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { Spinner } from "../../shared/ui/Spinner";
import type { BotCupApiGateway, BotCupEvent, TeamView } from "./BotCupApiGateway";
import { botCupErrorMessage } from "./botCupMessages";
import { BotCupAbout, BotCupFaq, BotCupRules, BotCupSchedule } from "./BotCupInfo";
import { FormAlert } from "./formParts";
import { AnnouncementsPanel } from "./AnnouncementsPanel";
import { InviteAccept } from "./InviteAccept";
import { LeaderboardPanel } from "./LeaderboardPanel";
import { LoginForm } from "./LoginForm";
import { RegisterFlow } from "./RegisterFlow";
import { TeamDashboard } from "./TeamDashboard";
import uetLogo from "./assets/uet-logo.webp";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { validateReplayDocument } from "../../../../../packages/arena/src/contracts/index.mjs";
import styles from "./botCup.module.css";

export type BotCupTab = "team" | "leaderboard" | "rules" | "schedule" | "faq";

const TABS: ReadonlyArray<readonly [BotCupTab, string]> = [
  ["team", "Tham gia"],
  ["leaderboard", "Bảng xếp hạng"],
  ["rules", "Thể lệ"],
  ["schedule", "Lịch"],
  ["faq", "Hỏi đáp"],
];

export interface BotCupScreenProps {
  readonly gateway: BotCupApiGateway;
  readonly onLobby: () => void;
  /** Invite token from ?invite= in the email link, read once by the app. */
  readonly inviteToken?: string | null;
  /** Opens a validated Arena replay document in the replay viewer. */
  readonly onStartReplay?: (document: ReplayDocument) => void;
}

type Load = { readonly status: "loading" } | { readonly status: "error"; readonly message: string } | { readonly status: "ready"; readonly event: BotCupEvent; readonly team: TeamView | null };

/** The Bot Cup flow (plan §4.1): event info for guests, registration and login, then the team page. */
export function BotCupScreen({ gateway, onLobby, inviteToken = null, onStartReplay }: BotCupScreenProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [tab, setTab] = useState<BotCupTab>("team");
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [invite, setInvite] = useState(inviteToken);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    Promise.all([gateway.getEvent(controller.signal), gateway.me(controller.signal)]).then(
      ([event, team]) => setLoad({ status: "ready", event, team }),
      (error) => {
        if (!controller.signal.aborted) setLoad({ status: "error", message: botCupErrorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [gateway, attempt]);

  const setTeam = useCallback((team: TeamView | null) => {
    setLoad((current) => (current.status === "ready" ? { ...current, team } : current));
  }, []);

  const header = (
    <header className={styles.header}>
      <img className={styles.headerLogo} src={uetLogo} alt="Logo Trường Đại học Công nghệ" width={56} height={56} />
      <div className={styles.headerText}>
        <h1 id="bot-cup-title">{load.status === "ready" ? load.event.name : "OTT Bot Cup"}</h1>
        <p>Giải lập trình bot Oẳn Tù Tì · Trường Đại học Công nghệ, ĐHQGHN</p>
      </div>
      {load.status === "ready" && load.event.mode === "demo" ? <Badge status="info">Bản thử nghiệm</Badge> : null}
      <Button variant="secondary" className={styles.headerButton} onClick={onLobby}>Về sảnh</Button>
    </header>
  );

  if (load.status === "loading") return <section className={styles.screen}>{header}<Panel><Spinner label="Đang tải giải đấu" /></Panel></section>;
  if (load.status === "error") {
    return (
      <section className={styles.screen}>
        {header}
        <Panel heading="Chưa mở được trang giải">
          <FormAlert message={load.message} />
          <Button onClick={() => setAttempt((value) => value + 1)}>Thử lại</Button>
        </Panel>
      </section>
    );
  }

  const { event, team } = load;
  const showRules = () => setTab("rules");
  // The API rebuilds replays with the real rules; check the document anyway before handing it to the viewer.
  const openReplay = onStartReplay
    ? (document: unknown) => {
        if (validateReplayDocument(document).ok) onStartReplay(document as ReplayDocument);
        else setNotice("Replay của trận này không hợp lệ. Hãy báo BTC.");
      }
    : undefined;
  return (
    <section className={styles.screen} aria-labelledby="bot-cup-title">
      {header}
      <nav className={styles.tabs} aria-label="Mục của giải">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={styles.tab} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {id === "team" && team ? "Đội của tôi" : label}
          </button>
        ))}
      </nav>

      {tab === "team" ? (
        <div className={styles.body}>
          <AnnouncementsPanel gateway={gateway} />
          {invite ? (
            <InviteAccept gateway={gateway} token={invite} onShowRules={showRules} onDone={() => setInvite(null)} />
          ) : team ? (
            <TeamDashboard gateway={gateway} event={event} team={team} onTeamChange={setTeam} onOpenReplay={openReplay}
              onSignedOut={(message) => { setTeam(null); setAuthMode("login"); setNotice(message ?? null); }} />
          ) : (
            <div className={styles.guest}>
              <BotCupAbout event={event} />
              <Panel>
                <div className={styles.authSwitch} role="group" aria-label="Đăng ký hoặc đăng nhập">
                  <button type="button" className={styles.tab} aria-pressed={authMode === "register"} onClick={() => setAuthMode("register")}>Đăng ký</button>
                  <button type="button" className={styles.tab} aria-pressed={authMode === "login"} onClick={() => setAuthMode("login")}>Đăng nhập</button>
                </div>
                <FormAlert tone="info" message={notice} />
                {authMode === "register" ? (
                  event.registrationOpen
                    ? <RegisterFlow gateway={gateway} event={event} onShowRules={showRules} onRegistered={(signedIn) => { setNotice(null); setTeam(signedIn); }} />
                    : <FormAlert tone="info" message="Hiện không trong thời gian đăng ký. Xem mục Lịch." />
                ) : (
                  <LoginForm gateway={gateway} event={event} onSignedIn={(signedIn) => { setNotice(null); setTeam(signedIn); }} />
                )}
              </Panel>
            </div>
          )}
        </div>
      ) : null}
      {tab === "leaderboard" ? <div className={styles.body}><LeaderboardPanel gateway={gateway} /></div> : null}
      {tab === "rules" ? <div className={styles.body}><BotCupRules event={event} /></div> : null}
      {tab === "schedule" ? <div className={styles.body}><BotCupSchedule event={event} /></div> : null}
      {tab === "faq" ? <div className={styles.body}><BotCupFaq /></div> : null}
    </section>
  );
}
