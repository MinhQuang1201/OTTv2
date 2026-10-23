/**
 * Cloudflare Turnstile check for registration, OTP sends, login and password reset (plan §5.3).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileVerifier({ secret, fetchImpl = fetch }) {
  return {
    async verify(token, remoteIp) {
      if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
      const form = new FormData();
      form.append("secret", secret);
      form.append("response", token);
      if (remoteIp && remoteIp !== "unknown") form.append("remoteip", remoteIp);
      try {
        const response = await fetchImpl(SITEVERIFY_URL, { method: "POST", body: form });
        const result = await response.json();
        return result?.success === true;
      } catch {
        return false;
      }
    }
  };
}

/** Local tests only (BOT_CUP_TURNSTILE_BYPASS=true): accepts any non-empty token. */
export const bypassTurnstile = Object.freeze({
  async verify(token) {
    return typeof token === "string" && token.length > 0;
  }
});
