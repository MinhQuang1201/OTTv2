import type { Database } from "better-sqlite3";

export interface OpenDatabaseOptions {
  sqlitePath?: string | null;
  migrationSql?: string | null;
  nativeBinding?: string | null;
  [key: string]: unknown;
}

export interface OpenDatabaseResult {
  db: Database;
  version: string;
}

export function openDatabase(
  dbPath: string,
  options?: OpenDatabaseOptions
): OpenDatabaseResult;

export function withTransaction<T>(db: Database, fn: () => T): T;

export function closeDatabase(db: Database): void;
