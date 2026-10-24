#!/usr/bin/env node
/**
 * Adds (or resets) a Bot Cup organiser in the `admins` table (plan §4.2, P6).
 *
 *   node scripts/bot-cup/admin-user.mjs <email> --role admin|viewer --env staging          # remote staging D1
 *   node scripts/bot-cup/admin-user.mjs <email> --role admin --env test --local           # local D1 of the dev servers
 *   node scripts/bot-cup/admin-user.mjs <email> --disable --env staging
 *
 * With Cloudflare Access only the row matters. For ADMIN_AUTH_MODE=password a random password and TOTP secret are
 * created and written to var/bot-cup/admin-<email>.txt (git-ignored), with an otpauth:// link for an authenticator app.
 * Nothing secret is printed.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../../apps/bot-cup-api/src/security.mjs";
import { base32Encode } from "../../apps/bot-cup-admin/src/auth.mjs";

const require = createRequire(import.meta.url);
const { spawnLocalCommand } = require("../worker-dev.js");
const { wranglerLauncher } = require("../../config/local-runtime.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASES = { staging: "ottv2-bot-cup-staging", test: "ottv2-bot-cup-test" };
const args = process.argv.slice(2);
const email = String(args[0] ?? "").trim().toLowerCase();
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const envName = value("--env");
const role = value("--role") ?? "admin";
const local = args.includes("--local");
if (!/^[^@\s'"]+@[^@\s'"]+\.[^@\s'"]+$/.test(email) || !DATABASES[envName] || !["admin", "viewer"].includes(role)) {
  console.error("Usage: node scripts/bot-cup/admin-user.mjs <email> --env staging|test [--local] [--role admin|viewer] [--disable]");
  process.exit(2);
}

let sql;
let secretFile = null;
if (args.includes("--disable")) {
  sql = `UPDATE admins SET disabled_at = ${Date.now()} WHERE email = '${email}'`;
} else {
  const password = randomBytes(18).toString("base64url");
  const totpSecret = base32Encode(randomBytes(20));
  const passwordHash = await hashPassword(password);
  sql = `INSERT INTO admins (email, role, added_by, created_at, password_hash, totp_secret) VALUES ('${email}', '${role}', 'admin-user.mjs', ${Date.now()}, '${passwordHash}', '${totpSecret}')
         ON CONFLICT (email) DO UPDATE SET role = excluded.role, password_hash = excluded.password_hash, totp_secret = excluded.totp_secret,
         disabled_at = NULL, failed_logins = 0, login_locked_until = NULL`.replace(/\s+/g, " ");
  secretFile = path.join(ROOT, "var/bot-cup", `admin-${email.replace(/[^a-z0-9.@-]/g, "_")}.txt`);
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  const label = encodeURIComponent(`OTT Bot Cup (${envName}):${email}`);
  fs.writeFileSync(secretFile, [
    `email: ${email}`,
    `role: ${role}`,
    `password: ${password}`,
    `totp secret: ${totpSecret}`,
    `otpauth: otpauth://totp/${label}?secret=${totpSecret}&issuer=OTT%20Bot%20Cup&algorithm=SHA1&digits=6&period=30`,
    ""
  ].join("\n"), { mode: 0o600 });
}

const launcher = wranglerLauncher();
const result = spawnLocalCommand(launcher.command, [
  ...launcher.argsPrefix, "d1", "execute", DATABASES[envName], "--config", "apps/bot-cup-api/wrangler.jsonc", "--env", envName,
  local ? "--local" : "--remote", ...(local ? ["--persist-to", ".wrangler/bot-cup-dev"] : []), "--command", sql
], { cwd: ROOT, stdio: "inherit", env: { ...process.env, CI: "1" } }, spawnSync);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(secretFile ? `admin ${email} (${role}): credentials in ${path.relative(ROOT, secretFile)}` : `admin ${email} disabled`);
