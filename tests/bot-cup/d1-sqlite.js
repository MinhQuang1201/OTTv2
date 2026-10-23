"use strict";

/**
 * In-memory stand-in for a Cloudflare D1 database, backed by better-sqlite3, so the Bot Cup API can be tested
 * in plain Node against the real migration files. Covers the D1 surface the API uses: prepare().bind(),
 * first(), all(), run() and batch() (atomic, like D1). Foreign keys are on, as they are in D1.
 */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const MIGRATIONS_DIR = path.resolve(__dirname, "../../apps/bot-cup-api/migrations");

function createD1() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  class Statement {
    constructor(sql, args = []) {
      this.sql = sql;
      this.args = args;
    }

    bind(...args) {
      for (const arg of args) {
        if (arg === undefined) throw new TypeError(`D1 cannot bind undefined (${this.sql.slice(0, 60)})`);
      }
      // D1 binds typed arrays and ArrayBuffers as BLOBs; better-sqlite3 wants a Buffer.
      const bound = args.map((arg) => {
        if (arg instanceof ArrayBuffer) return Buffer.from(arg);
        if (ArrayBuffer.isView(arg) && !Buffer.isBuffer(arg)) return Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength);
        return arg;
      });
      return new Statement(this.sql, bound);
    }

    execute() {
      const prepared = sqlite.prepare(this.sql);
      if (prepared.reader) return { results: prepared.all(...this.args), success: true, meta: {} };
      const info = prepared.run(...this.args);
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    }

    async first(column) {
      const prepared = sqlite.prepare(this.sql);
      const row = prepared.reader ? prepared.get(...this.args) : (prepared.run(...this.args), undefined);
      if (!row) return null;
      return column ? row[column] : row;
    }

    async all() {
      return this.execute();
    }

    async run() {
      return this.execute();
    }
  }

  return {
    sqlite,
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => sqlite.transaction(() => statements.map((statement) => statement.execute()))()
  };
}

module.exports = { createD1, MIGRATIONS_DIR };
