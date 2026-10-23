/**
 * Cloudflare Worker entry for the Bot Cup registration API. Wires env bindings into createBotCupApi.
 *
 * Bindings: DB (D1).
 * Vars:     BOT_CUP_EVENT_ID, BOT_CUP_WEB_ORIGIN, BOT_CUP_ALLOWED_ORIGINS (comma-separated), BOT_CUP_EMAIL_MODE
 *           ("brevo" | "outbox"), BOT_CUP_EMAIL_SENDER, BOT_CUP_EMAIL_SENDER_NAME, TURNSTILE_SITE_KEY,
 *           BOT_CUP_TURNSTILE_BYPASS ("true" only in the local test env).
 * Secrets:  OTP_PEPPER, BREVO_API_KEY (brevo mode), TURNSTILE_SECRET (unless bypassed), BOT_CUP_DEV_TOKEN (optional;
 *           enables GET /api/t/_dev/outbox for whoever holds it).
 */
import { createBotCupApi } from "./app.mjs";
import { createBrevoMailer, createOutboxMailer } from "./mail.mjs";
import { bypassTurnstile, createTurnstileVerifier } from "./turnstile.mjs";

const now = () => Date.now();

function misconfigured(reason) {
  console.error(JSON.stringify({ event: "bot_cup_misconfigured", reason }));
  return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: { "content-type": "application/json" } });
}

export function apiFromEnv(env) {
  if (!env.DB) return { error: "missing DB binding" };
  if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 16) return { error: "OTP_PEPPER must be at least 16 characters" };
  if (!env.BOT_CUP_EVENT_ID || !env.BOT_CUP_WEB_ORIGIN) return { error: "missing BOT_CUP_EVENT_ID or BOT_CUP_WEB_ORIGIN" };

  let mailer;
  if (env.BOT_CUP_EMAIL_MODE === "brevo") {
    if (!env.BREVO_API_KEY || !env.BOT_CUP_EMAIL_SENDER) return { error: "brevo mode needs BREVO_API_KEY and BOT_CUP_EMAIL_SENDER" };
    mailer = createBrevoMailer({ apiKey: env.BREVO_API_KEY, senderEmail: env.BOT_CUP_EMAIL_SENDER, senderName: env.BOT_CUP_EMAIL_SENDER_NAME || "OTT Bot Cup" });
  } else if (env.BOT_CUP_EMAIL_MODE === "outbox") {
    mailer = createOutboxMailer({ db: env.DB, now });
  } else {
    return { error: "BOT_CUP_EMAIL_MODE must be brevo or outbox" };
  }

  let turnstile;
  if (env.BOT_CUP_TURNSTILE_BYPASS === "true") turnstile = bypassTurnstile;
  else if (env.TURNSTILE_SECRET) turnstile = createTurnstileVerifier({ secret: env.TURNSTILE_SECRET });
  else return { error: "missing TURNSTILE_SECRET" };

  const allowedOrigins = String(env.BOT_CUP_ALLOWED_ORIGINS || env.BOT_CUP_WEB_ORIGIN).split(",").map((origin) => origin.trim()).filter(Boolean);
  return {
    api: createBotCupApi({
      db: env.DB,
      mailer,
      turnstile,
      now,
      config: {
        eventId: env.BOT_CUP_EVENT_ID,
        otpPepper: env.OTP_PEPPER,
        webOrigin: env.BOT_CUP_WEB_ORIGIN.replace(/\/$/, ""),
        allowedOrigins,
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
        devToken: env.BOT_CUP_DEV_TOKEN || null
      }
    })
  };
}

export default {
  async fetch(request, env) {
    const { api, error } = apiFromEnv(env);
    if (error) return misconfigured(error);
    return api.fetch(request);
  }
};
