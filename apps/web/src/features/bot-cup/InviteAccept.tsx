import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { Spinner } from "../../shared/ui/Spinner";
import type { BotCupApiGateway, InvitePreview } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage, teamStatusLabel } from "./botCupMessages";
import { Checkbox, FormAlert } from "./formParts";
import styles from "./botCup.module.css";

/** The page an invited member reaches from the email link (?view=bot-cup&invite=…). */
export function InviteAccept({ gateway, token, onDone, onShowRules }: {
  readonly gateway: BotCupApiGateway;
  readonly token: string;
  readonly onDone: () => void;
  readonly onShowRules: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [showName, setShowName] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ teamName: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      setLoadError(BOT_CUP_ERROR_MESSAGES.invite_invalid);
      return;
    }
    const controller = new AbortController();
    gateway.previewInvite(token).then(setPreview, (cause) => {
      if (!controller.signal.aborted) setLoadError(botCupErrorMessage(cause));
    });
    return () => controller.abort();
  }, [gateway, token]);

  const accept = async () => {
    if (!consent) {
      setError("Bạn cần đồng ý với thể lệ và việc xử lý dữ liệu cá nhân.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAccepted(await gateway.acceptInvite(token, consent, showName));
    } catch (cause) {
      setError(botCupErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <Panel heading="Lời mời vào đội">
        <FormAlert message={loadError} />
        <Button variant="secondary" onClick={onDone}>Tiếp tục</Button>
      </Panel>
    );
  }
  if (!preview) return <Panel heading="Lời mời vào đội"><Spinner label="Đang kiểm tra lời mời" /></Panel>;
  if (accepted) {
    return (
      <Panel heading="Đã tham gia đội">
        <FormAlert tone="success" message={`Bạn đã xác nhận tham gia đội "${accepted.teamName}". Trạng thái đội: ${teamStatusLabel(accepted.status)}.`} />
        <p>Đội đăng nhập bằng tên đăng nhập và mật khẩu chung mà đội trưởng đã tạo.</p>
        <Button onClick={onDone}>Xong</Button>
      </Panel>
    );
  }
  return (
    <Panel heading="Lời mời vào đội">
      <p>Chào <strong>{preview.fullName}</strong>, bạn được mời vào đội <strong>{preview.teamName}</strong> tại {preview.eventName}.</p>
      <p className={styles.hint}>Lời mời gửi tới {preview.email}.</p>
      {!preview.registrationOpen ? <FormAlert message="Đã hết thời gian đăng ký, không thể xác nhận lời mời." /> : (
        <div className={styles.form}>
          <Checkbox checked={showName} onChange={setShowName}>Hiện họ tên của tôi trên trang giải (MSSV và email không bao giờ công khai).</Checkbox>
          <Checkbox checked={consent} onChange={setConsent}>
            Tôi đồng ý với <button type="button" className={styles.linkButton} onClick={onShowRules}>thể lệ giải</button> và cho phép Ban tổ chức xử lý họ tên, MSSV, email để tổ chức giải.
          </Checkbox>
          <FormAlert message={error} />
          <div className={styles.actions}>
            <Button onClick={() => void accept()} disabled={busy}>Xác nhận tham gia</Button>
            <Button variant="quiet" onClick={onDone}>Để sau</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
