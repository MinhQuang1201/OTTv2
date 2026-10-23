#!/usr/bin/env node
/**
 * P0 email deliverability check for the Bot Cup plan (§5.4, §12 P0): sends one OTP-style email per recipient
 * through the Brevo transactional API, so BTC can record inbox vs spam and delivery time for vnu.edu.vn and Gmail.
 *
 *   BREVO_API_KEY=... BOT_CUP_SENDER_EMAIL=... node scripts/bot-cup/p0-send-test-email.mjs --to a@vnu.edu.vn,b@gmail.com
 *
 * Env (also read from .env if present): BREVO_API_KEY, BOT_CUP_SENDER_EMAIL (a sender verified in Brevo),
 * BOT_CUP_SENDER_NAME (default "OTT Bot Cup"). The sent codes are test values, written with the Brevo message ids
 * and send times to var/bot-cup/p0/email-<timestamp>.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // .env is optional; the variables may come from the shell.
}

const toIndex = process.argv.indexOf("--to");
const recipients = (toIndex > 0 ? process.argv[toIndex + 1] || "" : "").split(",").map((s) => s.trim()).filter(Boolean);
const { BREVO_API_KEY, BOT_CUP_SENDER_EMAIL, BOT_CUP_SENDER_NAME = "OTT Bot Cup" } = process.env;
if (!BREVO_API_KEY || !BOT_CUP_SENDER_EMAIL || recipients.length === 0) {
  console.error("Usage: BREVO_API_KEY=... BOT_CUP_SENDER_EMAIL=... node scripts/bot-cup/p0-send-test-email.mjs --to a@vnu.edu.vn,b@gmail.com");
  process.exit(2);
}

function message(code) {
  const text = [
    "Xin chào,",
    "",
    `Mã xác minh OTT Bot Cup của bạn là: ${code}`,
    "Mã có hiệu lực trong 10 phút. Nếu bạn không đăng ký, hãy bỏ qua email này.",
    "",
    "(Email thử nghiệm khả năng gửi thư — giai đoạn P0.)"
  ].join("\n");
  const html = `<p>Xin chào,</p><p>Mã xác minh OTT Bot Cup của bạn là:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#00477F">${code}</p>
<p>Mã có hiệu lực trong 10 phút. Nếu bạn không đăng ký, hãy bỏ qua email này.</p>
<p style="color:#666;font-size:12px">Email thử nghiệm khả năng gửi thư — giai đoạn P0.</p>`;
  return { subject: `[OTT Bot Cup] Mã xác minh: ${code}`, text, html };
}

const results = [];
for (const email of recipients) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const { subject, text, html } = message(code);
  const sentAt = new Date().toISOString();
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: BOT_CUP_SENDER_NAME, email: BOT_CUP_SENDER_EMAIL },
      to: [{ email }],
      subject,
      textContent: text,
      htmlContent: html
    })
  });
  const body = await response.json().catch(() => ({}));
  const result = { email, code, sentAt, status: response.status, messageId: body.messageId ?? null, error: response.ok ? null : body.message ?? null };
  results.push(result);
  console.log(`${response.ok ? "sent" : "FAILED"} ${email} code=${code} status=${response.status}${result.error ? ` error=${result.error}` : ""}`);
}

const outDir = path.join(ROOT, "var/bot-cup/p0");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `email-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outFile, JSON.stringify({ sender: BOT_CUP_SENDER_EMAIL, results }, null, 2));
console.log(`written: ${path.relative(ROOT, outFile)} — ghi lại inbox/spam và thời gian nhận cho từng địa chỉ.`);
process.exit(results.every((r) => r.status >= 200 && r.status < 300) ? 0 : 1);
