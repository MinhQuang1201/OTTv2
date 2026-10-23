#!/usr/bin/env node
/**
 * Local Bot Cup API for web development: applies the migrations to a local D1 under .wrangler/bot-cup-dev, seeds an
 * open demo event, then runs `wrangler dev` (env "test": mail goes to dev_outbox, Turnstile is bypassed) on port 8789,
 * which the Vite dev server proxies as /api/t.
 *
 *   npm run bot-cup:api:dev      # then: npm run dev:web   (with VITE_OTT_BOT_CUP_ENABLED=true in .env)
 *
 * Read OTP and invite emails at http://127.0.0.1:8789/api/t/_dev/outbox?to=<email> with "Authorization: Bearer dev".
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { spawnLocalCommand } = require("../worker-dev.js");
const { wranglerLauncher } = require("../../config/local-runtime.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const local = ["--config", "apps/bot-cup-api/wrangler.jsonc", "--env", "test", "--local", "--persist-to", ".wrangler/bot-cup-dev"];
const launcher = wranglerLauncher();

function wranglerSync(args) {
  const child = spawnLocalCommand(launcher.command, [...launcher.argsPrefix, ...args], { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1" } }, spawnSync);
  if (child.status !== 0) process.exit(child.status ?? 1);
}

const now = Date.now();
wranglerSync(["d1", "migrations", "apply", "ottv2-bot-cup-test", ...local]);
wranglerSync(["d1", "execute", "ottv2-bot-cup-test", ...local, "--command",
  `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, practice_opens_at) VALUES ('test-event', 'OTT Bot Cup (local)', 'demo', ${now - 86_400_000}, ${now + 30 * 86_400_000}, ${now + 7 * 86_400_000})
   ON CONFLICT (id) DO UPDATE SET registration_opens_at = excluded.registration_opens_at, registration_closes_at = excluded.registration_closes_at, practice_opens_at = excluded.practice_opens_at`]);

const dev = spawnLocalCommand(launcher.command, [
  ...launcher.argsPrefix, "dev", ...local, "--ip", "127.0.0.1", "--port", "8789", "--show-interactive-dev-session=false",
  "--var", "OTP_PEPPER:local-dev-pepper-0123456789", "--var", "BOT_CUP_DEV_TOKEN:dev",
], { cwd: root, stdio: "inherit" }, spawn);
dev.on("exit", (code) => process.exit(code ?? 0));
