/**
 * Outgoing email: the Brevo transactional API in staging/production, a D1 outbox table in local tests (and in staging
 * until the provider is configured). Templates are Vietnamese plain text plus a minimal HTML version.
 */

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function html(paragraphs) {
  return paragraphs.map((p) => (p.code ? `<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#00477F">${escapeHtml(p.code)}</p>`
    : p.link ? `<p><a href="${escapeHtml(p.link)}">${escapeHtml(p.label)}</a></p>` : `<p>${escapeHtml(p)}</p>`)).join("\n");
}

/** @param {{ eventName: string, teamName: string, code: string, purpose: "register"|"reset" }} input */
export function otpEmail({ eventName, teamName, code, purpose }) {
  const action = purpose === "reset" ? `đặt lại mật khẩu cho đội "${teamName}"` : `xác minh đăng ký đội "${teamName}"`;
  const lines = [
    "Xin chào,",
    `Mã để ${action} tại ${eventName} là:`,
    { code },
    "Mã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này."
  ];
  return {
    subject: `[${eventName}] Mã xác minh: ${code}`,
    text: lines.map((line) => (typeof line === "string" ? line : line.code)).join("\n\n"),
    html: html(lines)
  };
}

/** @param {{ eventName: string, teamName: string, fullName: string, inviter: string, link: string }} input */
export function inviteEmail({ eventName, teamName, fullName, inviter, link }) {
  const lines = [
    `Chào ${fullName},`,
    `${inviter} đã mời bạn vào đội "${teamName}" tại ${eventName}.`,
    "Mở liên kết dưới đây để xác nhận tham gia (liên kết dùng một lần, hết hạn sau 72 giờ):",
    { link, label: link },
    "Nếu bạn không biết đội này, hãy bỏ qua email."
  ];
  return {
    subject: `[${eventName}] Lời mời vào đội ${teamName}`,
    text: lines.map((line) => (typeof line === "string" ? line : line.link)).join("\n\n"),
    html: html(lines)
  };
}

export function createBrevoMailer({ apiKey, senderEmail, senderName, fetchImpl = fetch }) {
  return {
    async send({ to, subject, text, html: htmlContent }) {
      const response = await fetchImpl(BREVO_URL, {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject, textContent: text, htmlContent })
      });
      if (!response.ok) throw new Error(`brevo_status_${response.status}`);
    }
  };
}

export function createOutboxMailer({ db, now }) {
  return {
    async send({ to, subject, text }) {
      await db.prepare("INSERT INTO dev_outbox (to_email, subject, text_body, created_at) VALUES (?, ?, ?, ?)").bind(to, subject, text, now()).run();
    }
  };
}
