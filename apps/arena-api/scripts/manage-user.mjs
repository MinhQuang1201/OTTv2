/**
 * apps/arena-api/scripts/manage-user.mjs
 *
 * Admin CLI script for user account management:
 * - Bootstraps admin and author accounts with scrypt password hashing.
 * - Supports masked interactive password input when stdin is a TTY.
 * - Supports non-interactive flags for scripted and test environments.
 * - Enforces role restrictions ('author', 'admin') and account status ('active', 'suspended', 'deleted').
 *
 * Usage:
 *   node apps/arena-api/scripts/manage-user.mjs create --username <name> --role <admin|author> [--password <pwd>] [--db <path>]
 *   node apps/arena-api/scripts/manage-user.mjs set-status --username <name> --status <active|suspended|deleted> [--db <path>]
 *   node apps/arena-api/scripts/manage-user.mjs list [--db <path>]
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../src/auth/accounts.mjs";
import { openDatabase, closeDatabase } from "../../../packages/arena-node/src/persistence/sqlite-database.mjs";

/**
 * Prompts user for masked password on interactive TTY stdin.
 *
 * @param {string} [promptText="Enter password: "]
 * @returns {Promise<string>}
 */
export async function promptMaskedPassword(promptText = "Enter password: ") {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";
    const onData = (ch) => {
      ch = ch.toString();
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(password);
      } else if (ch === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (ch === "\b" || ch === "\u007f") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        password += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function parseArgs(args) {
  const parsed = {
    command: args[0],
    username: null,
    role: "author",
    password: null,
    status: "active",
    dbPath: process.env.ARENA_DB_PATH || "var/arena/arena.db"
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--username" && i + 1 < args.length) {
      parsed.username = args[++i];
    } else if (arg === "--role" && i + 1 < args.length) {
      parsed.role = args[++i];
    } else if (arg === "--password" && i + 1 < args.length) {
      parsed.password = args[++i];
    } else if (arg === "--status" && i + 1 < args.length) {
      parsed.status = args[++i];
    } else if (arg === "--db" && i + 1 < args.length) {
      parsed.dbPath = args[++i];
    }
  }

  return parsed;
}

/**
 * Main execution handler for user management CLI.
 *
 * @param {string[]} argv
 * @param {object} [io={}]
 * @returns {Promise<number>} Exit code (0 for success, 1 for error)
 */
export async function manageUserCli(argv, io = {}) {
  const stdout = io.stdout || ((msg) => console.log(msg));
  const stderr = io.stderr || ((msg) => console.error(msg));

  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.command === "--help" || parsed.command === "-h") {
    stderr(
      "Usage:\n" +
        "  manage-user create --username <name> --role <admin|author> [--password <pwd>] [--db <path>]\n" +
        "  manage-user set-status --username <name> --status <active|suspended|deleted> [--db <path>]\n" +
        "  manage-user list [--db <path>]"
    );
    return 1;
  }

  const resolvedDbPath = path.resolve(parsed.dbPath);
  const dbDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  let db;
  try {
    const opened = openDatabase(resolvedDbPath, nativeBinding ? { nativeBinding } : {});
    db = opened.db;
  } catch (err) {
    stderr(`Database connection failed: ${err.message}`);
    return 1;
  }

  try {
    if (parsed.command === "create") {
      if (!parsed.username || parsed.username.trim().length === 0) {
        stderr("Error: --username is required");
        return 1;
      }

      if (parsed.role !== "admin" && parsed.role !== "author") {
        stderr("Error: --role must be 'admin' or 'author'");
        return 1;
      }

      let password = parsed.password;
      if (!password) {
        if (process.stdin.isTTY) {
          password = await promptMaskedPassword(`Password for ${parsed.username}: `);
        } else {
          stderr("Error: --password is required in non-interactive mode");
          return 1;
        }
      }

      if (!password || password.trim().length === 0) {
        stderr("Error: password cannot be empty");
        return 1;
      }

      const normalizedUsername = parsed.username.trim().toLowerCase();
      const existing = db
        .prepare("SELECT 1 FROM users WHERE normalized_username = ?")
        .get(normalizedUsername);

      if (existing) {
        stderr(`Error: user "${normalizedUsername}" already exists`);
        return 1;
      }

      const validStatuses = new Set(["active", "suspended", "deleted"]);
      const status = parsed.status || "active";
      if (!validStatuses.has(status)) {
        stderr(`Error: invalid status "${status}". Must be active, suspended, or deleted.`);
        return 1;
      }

      const userId = `usr-${randomUUID()}`;
      const passwordHash = hashPassword(password);

      db.prepare(`
        INSERT INTO users (id, normalized_username, password_hash, role, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, normalizedUsername, passwordHash, parsed.role, status);

      stdout(`User created successfully: ${normalizedUsername} (${userId}) [role: ${parsed.role}]`);
      return 0;
    }

    if (parsed.command === "set-status") {
      if (!parsed.username) {
        stderr("Error: --username is required");
        return 1;
      }
      const validStatuses = new Set(["active", "suspended", "deleted"]);
      if (!validStatuses.has(parsed.status)) {
        stderr(`Error: invalid status "${parsed.status}". Must be active, suspended, or deleted.`);
        return 1;
      }

      const normalizedUsername = parsed.username.trim().toLowerCase();
      const res = db
        .prepare("UPDATE users SET status = ? WHERE normalized_username = ?")
        .run(parsed.status, normalizedUsername);

      if (res.changes === 0) {
        stderr(`Error: user "${normalizedUsername}" not found`);
        return 1;
      }

      stdout(`Updated user "${normalizedUsername}" status to "${parsed.status}"`);
      return 0;
    }

    if (parsed.command === "list") {
      const rows = db.prepare("SELECT id, normalized_username, role, status, created_at FROM users").all();
      stdout(`Users count: ${rows.length}`);
      for (const row of rows) {
        stdout(` - ${row.normalized_username} (${row.id}) | role: ${row.role} | status: ${row.status}`);
      }
      return 0;
    }

    stderr(`Error: unknown command "${parsed.command}"`);
    return 1;
  } finally {
    if (db) {
      closeDatabase(db);
    }
  }
}

// Direct CLI invocation
const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("apps/arena-api/scripts/manage-user.mjs") ||
    process.argv[1].endsWith("apps\\arena-api\\scripts\\manage-user.mjs"));

if (isMain) {
  manageUserCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
