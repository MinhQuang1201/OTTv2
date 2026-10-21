import { randomUUID } from "node:crypto";
import { hashPassword } from "./accounts.mjs";

function registrationError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Creates an author account only. Registration never creates a session. */
export function registerAuthor(db, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some(key => key !== "username" && key !== "password") ||
      typeof payload.username !== "string" || typeof payload.password !== "string") {
    throw registrationError(400, "INVALID_PAYLOAD", "Provide only username and password as strings");
  }
  const username = payload.username.trim().toLowerCase();
  const password = payload.password;
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    throw registrationError(422, "VALIDATION_ERROR", "Username must contain 3–32 letters, numbers, dots, underscores or hyphens");
  }
  if (password.length < 8 || password.length > 128) {
    throw registrationError(422, "VALIDATION_ERROR", "Password must contain 8–128 characters");
  }

  // Hash outside the short write transaction; the unique constraint owns races.
  const passwordHash = hashPassword(password);
  const user = { id: `usr-${randomUUID()}`, username, role: "author" };
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, 'author', 'active')")
        .run(user.id, username, passwordHash);
    }).immediate();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
        error.message === "UNIQUE constraint failed: users.normalized_username") {
      throw registrationError(409, "USERNAME_TAKEN", "Username is already taken");
    }
    throw error;
  }
  return user;
}
