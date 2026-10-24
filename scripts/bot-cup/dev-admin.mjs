#!/usr/bin/env node
/**
 * Local Bot Cup admin site on port 8790 (env "test", ADMIN_AUTH_MODE=password), sharing the local D1 of
 * `npm run bot-cup:api:dev`. Start that one first (it applies the migrations), then add an organiser with
 * `node scripts/bot-cup/admin-user.mjs you@example.com --env test --local`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { spawnLocalCommand } = require("../worker-dev.js");
const { wranglerLauncher } = require("../../config/local-runtime.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = wranglerLauncher();
const dev = spawnLocalCommand(launcher.command, [
  ...launcher.argsPrefix, "dev", "--config", "apps/bot-cup-admin/wrangler.jsonc", "--env", "test", "--local",
  "--persist-to", ".wrangler/bot-cup-dev", "--ip", "127.0.0.1", "--port", "8790", "--inspector-port", "0", "--show-interactive-dev-session=false"
], { cwd: root, stdio: "inherit" }, spawn);
dev.on("exit", (code) => process.exit(code ?? 0));
