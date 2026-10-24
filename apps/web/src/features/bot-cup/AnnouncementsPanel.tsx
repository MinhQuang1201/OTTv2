import { useEffect, useState } from "react";
import { Panel } from "../../shared/ui/Panel";
import type { Announcement, BotCupApiGateway } from "./BotCupApiGateway";
import { formatDateTime } from "./botCupFormat";
import styles from "./botCup.module.css";

/** The organisers' published announcements (plan §4.1). Renders nothing when there are none or they cannot load. */
export function AnnouncementsPanel({ gateway }: { readonly gateway: BotCupApiGateway }) {
  const [items, setItems] = useState<readonly Announcement[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    gateway.getAnnouncements(controller.signal).then((result) => setItems(result.announcements), () => setItems([]));
    return () => controller.abort();
  }, [gateway]);

  if (!items.length) return null;
  return (
    <Panel heading="Thông báo của Ban tổ chức" className={styles.submissionsCard}>
      <ul className={styles.announcements}>
        {items.map((item) => (
          <li key={item.id}>
            <h3 className={styles.subheading}>{item.title}</h3>
            <p className={styles.hint}>{formatDateTime(item.publishedAt)}</p>
            <p className={styles.announcementBody}>{item.body}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
