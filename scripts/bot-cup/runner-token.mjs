#!/usr/bin/env node
/**
 * Creates a Bot Cup runner token (plan §8.4, §9.2). The token is written to a file (never printed) and only its SHA-256
 * goes into D1.
 *
 *   node scripts/bot-cup/runner-token.mjs <name> --env staging        # remote staging D1
 *   node scripts/bot-cup/runner-token.mjs <name> --env test --local   # local D1 of `npm run bot-cup:api:dev`
 *   node scripts/bot-cup/runner-token.mjs <name> --revoke --env staging
 *
 * Token file: var/bot-cup/runner-token-<name>.txt (git-ignored). Point the runner at it with BOT_CUP_RUNNER_TOKEN_FILE.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { spawnLocalCommand } = require("../worker-dev.js");
const { wranglerLauncher } = require("../../config/local-runtime.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASES = { staging: "ottv2-bot-cup-staging", test: "ottv2-bot-cup-test", production: "ottv2-bot-cup" };

const args = process.argv.slice(2);
const name = args[0];
const envName = args[args.indexOf("--env") + 1];
const local = args.includes("--local");
const revoke = args.includes("--revoke");
if (!name || !/^[a-z0-9-]{2,32}$/.test(name) || !args.includes("--env") || !DATABASES[envName]) {
  console.error("Usage: node scripts/bot-cup/runner-token.mjs <name a-z0-9-> --env staging|test [--local] [--revoke]");
  process.exit(2);
}
if (envName === "production") {
  console.error("Refusing production: create production runners by hand when the real event is scheduled.");
  process.exit(2);
}

let sql;
let tokenFile = null;
if (revoke) {
  sql = `UPDATE runners SET revoked_at = ${Date.now()} WHERE name = '${name}'`;
} else {
  const token = randomBytes(32).toString("base64url");
  tokenFile = path.join(ROOT, "var/bot-cup", `runner-token-${name}.txt`);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const hash = createHash("sha256").update(token).digest("hex");
  sql = `INSERT INTO runners (id, name, token_hash, created_at) VALUES ('${randomUUID()}', '${name}', '${hash}', ${Date.now()}) ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = NULL`;
}

const launcher = wranglerLauncher();
const wranglerArgs = [
  ...launcher.argsPrefix, "d1", "execute", DATABASES[envName], "--config", "apps/bot-cup-api/wrangler.jsonc", "--env", envName,
  local ? "--local" : "--remote", ...(local ? ["--persist-to", ".wrangler/bot-cup-dev"] : []), "--command", sql
];
const result = spawnLocalCommand(launcher.command, wranglerArgs, { cwd: ROOT, stdio: "inherit", env: { ...process.env, CI: "1" } }, spawnSync);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(revoke ? `revoked runner ${name}` : `runner ${name}: token written to ${path.relative(ROOT, tokenFile)}`);
