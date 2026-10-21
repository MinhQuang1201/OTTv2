import { Button } from "../../shared/ui/Button";
import { inviteLink } from "../../sessions/online/roomCode";
import styles from "./game.module.css";

export interface InviteBannerProps {
  readonly code: string;
  readonly onCopied: (message: string, ok: boolean) => void;
  readonly copyText?: (text: string) => Promise<void>;
  readonly link?: string;
}

async function clipboardWrite(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

/** Shown while an online room waits for its second player: the short code and an invite link to share. */
export function InviteBanner({ code, onCopied, copyText = clipboardWrite, link = inviteLink(code) }: InviteBannerProps) {
  const copy = async (text: string, label: string) => {
    try {
      await copyText(text);
      onCopied(`Đã sao chép ${label}.`, true);
    } catch {
      onCopied(`Không sao chép được ${label}. Hãy chép thủ công: ${text}`, false);
    }
  };
  return (
    <section className={styles.inviteBanner} aria-label="Mời người chơi thứ hai">
      <p className={styles.inviteLabel}>Gửi mã này cho bạn của bạn</p>
      <strong className={styles.inviteCode} data-testid="room-alias">{code}</strong>
      <div className={styles.inviteActions}>
        <Button variant="secondary" onClick={() => void copy(code, "mã phòng")}>Sao chép mã</Button>
        <Button variant="quiet" onClick={() => void copy(link, "link mời")}>Sao chép link mời</Button>
      </div>
    </section>
  );
}
