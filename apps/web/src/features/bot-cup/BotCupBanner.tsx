import { useEffect, useState } from "react";
import type { BotCupApiGateway, BotCupEvent } from "./BotCupApiGateway";
import { bannerLine } from "./botCupFormat";
import uetLogo from "./assets/uet-logo.webp";
import styles from "./botCupBanner.module.css";

export interface BotCupBannerProps {
  readonly gateway: BotCupApiGateway;
  readonly onOpen: () => void;
  /** Injected in tests; defaults to Date.now. */
  readonly now?: () => number;
}

/** Lobby banner for the Bot Cup (plan §11.1). The whole banner is one button that opens the event screen. */
export function BotCupBanner({ gateway, onOpen, now = Date.now }: BotCupBannerProps) {
  const [event, setEvent] = useState<BotCupEvent | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    gateway.getEvent(controller.signal).then(setEvent, () => undefined);
    return () => controller.abort();
  }, [gateway]);

  const title = event?.name ?? "OTT Bot Cup";
  const line = bannerLine(event, now());
  return (
    <button type="button" className={styles.banner} onClick={onOpen} aria-label={`${title}: ${line}. Mở trang giải đấu`}>
      <img className={styles.logo} src={uetLogo} alt="" width={64} height={64} />
      <span className={styles.text}>
        <span className={styles.eyebrow}>Trường Đại học Công nghệ · ĐHQGHN{event?.mode === "demo" ? " · Bản thử nghiệm" : ""}</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.line}>{line}</span>
      </span>
      <span className={styles.cta} aria-hidden="true">Tham gia ›</span>
    </button>
  );
}
