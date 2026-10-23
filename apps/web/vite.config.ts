import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// apps/web/tsconfig.json has no Node types; this config only reads one variable from the build environment.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

// The Bot Cup API (apps/bot-cup-api) is reached same-origin at /api/t so its session cookie stays first-party:
// the Vite dev server proxies it, and a deployed build gets a Vercel rewrite to the Worker named here.
const botCupApiOrigin = process.env.OTT_BOT_CUP_API_ORIGIN?.trim().replace(/\/$/, "") || "";
if (botCupApiOrigin && !/^https?:\/\/[^/]+$/.test(botCupApiOrigin)) {
  throw new Error(`OTT_BOT_CUP_API_ORIGIN must be an origin such as https://name.workers.dev, got "${botCupApiOrigin}"`);
}

function botCupVercelRewrite(): Plugin {
  return {
    name: "ott-bot-cup-vercel-rewrite",
    apply: "build",
    generateBundle() {
      if (!botCupApiOrigin) return;
      const config = { rewrites: [{ source: "/api/t/:path*", destination: `${botCupApiOrigin}/api/t/:path*` }] };
      this.emitFile({ type: "asset", fileName: "vercel.json", source: `${JSON.stringify(config, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  root: "apps/web",
  envDir: "../..",
  publicDir: "static",
  plugins: [react(), botCupVercelRewrite()],
  server: {
    proxy: {
      // `npm run bot-cup:api:dev` serves the API on this port.
      "/api/t": { target: botCupApiOrigin || "http://127.0.0.1:8789" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
