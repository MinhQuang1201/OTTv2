/**
 * Cloudflare Worker for the Bot Cup admin site (plan §4.2): static page from ./public (ASSETS) and the API at /admin-api,
 * on its own hostname, sharing the D1 database of apps/bot-cup-api.
 *
 * Bindings: DB (D1), ASSETS (static assets).
 * Vars:     BOT_CUP_EVENT_ID, ADMIN_AUTH_MODE ("access" default | "password"), ACCESS_TEAM_DOMAIN, ACCESS_AUD,
 *           ADMIN_ALLOWED_ORIGINS (comma-separated; defaults to the request's own origin).
 */
import { createAdminApi } from "./app.mjs";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store"
};

function withHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function misconfigured(reason) {
  console.error(JSON.stringify({ event: "bot_cup_admin_misconfigured", reason }));
  return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env) {
    if (!env.DB || !env.BOT_CUP_EVENT_ID) return misconfigured("missing DB or BOT_CUP_EVENT_ID");
    const authMode = env.ADMIN_AUTH_MODE || "access";
    if (authMode === "access" && (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)) return misconfigured("access mode needs ACCESS_TEAM_DOMAIN and ACCESS_AUD");
    if (!["access", "password"].includes(authMode)) return misconfigured("ADMIN_AUTH_MODE must be access or password");

    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin-api/")) {
      const allowedOrigins = String(env.ADMIN_ALLOWED_ORIGINS || url.origin).split(",").map((origin) => origin.trim()).filter(Boolean);
      const api = createAdminApi({
        db: env.DB,
        now: () => Date.now(),
        config: { eventId: env.BOT_CUP_EVENT_ID, authMode, access: { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, allowedOrigins }
      });
      return withHeaders(await api.fetch(request));
    }
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
