import type { Database } from "better-sqlite3";

export class IdempotencyConflictError extends Error {
  code: "IDEMPOTENCY_CONFLICT";
  idempotencyKey: string;
  operation: string;
  constructor(key: string, operation: string);
}

export class NotFoundError extends Error {
  code: "NOT_FOUND";
  resource: string;
  resourceId: string;
  constructor(resource: string, id: string);
}

export class OwnershipError extends Error {
  code: "OWNERSHIP_DENIED";
  resource: string;
  resourceId: string;
  actorId: string;
  constructor(resource: string, id: string, actorId: string);
}

export interface UserRecord {
  id: string;
  normalized_username: string;
  password_hash: string;
  role: "author" | "admin";
  status: "active" | "suspended" | "deleted";
  created_at: string;
}

export interface BotRecord {
  id: string;
  owner_id: string;
  name: string;
  status: "active" | "suspended" | "deleted";
  created_at: string;
}

export interface BotVersionRecord {
  id: string;
  bot_id: string;
  version_no: number;
  source_digest: string;
  profile_id: string;
  profile_revision: string;
  build_status: "pending" | "building" | "ready" | "failed";
  artifact_digest: string | null;
  build_log: string | null;
  created_at: string;
}

export interface ArtifactRecord {
  digest: string;
  kind: "source" | "build";
  relative_private_path: string;
  bytes: number;
  created_at: string;
}

export interface CreateUserArgs {
  id: string;
  normalizedUsername: string;
  passwordHash: string;
  role?: "author" | "admin";
}

export interface CreateBotArgs {
  id: string;
  ownerId: string;
  name: string;
}

export interface CreateVersionArgs {
  id: string;
  botId: string;
  sourceDigest: string;
  profileId: string;
  profileRevision: string;
}

export interface MarkVersionReadyArgs {
  botVersionId: string;
  artifactDigest?: string | null;
  buildLog?: string | null;
}

export interface MarkVersionFailedArgs {
  botVersionId: string;
  buildLog?: string | null;
}

export interface RegisterArtifactArgs {
  digest: string;
  kind: "source" | "build";
  relativePrivatePath: string;
  bytes: number;
}

export interface IdempotencyOptions {
  idempotencyKey: string;
  actorId: string;
}

export interface BotRepository {
  createUser(args: CreateUserArgs): UserRecord;
  createBot(args: CreateBotArgs, options: IdempotencyOptions): BotRecord;
  createVersion(args: CreateVersionArgs, options: IdempotencyOptions): BotVersionRecord;
  markVersionReady(args: MarkVersionReadyArgs): BotVersionRecord;
  markVersionFailed(args: MarkVersionFailedArgs): BotVersionRecord;
  registerArtifact(args: RegisterArtifactArgs): ArtifactRecord;
  getUser(userId: string): UserRecord | undefined;
  getBot(botId: string): BotRecord | undefined;
  getBotVersion(versionId: string): BotVersionRecord | undefined;
  getReadyVersion(botId: string, versionNo: number): BotVersionRecord | undefined;
  listBotVersions(botId: string): BotVersionRecord[];
  getArtifact(digest: string): ArtifactRecord | undefined;
}

export function createBotRepository(db: Database): BotRepository;
