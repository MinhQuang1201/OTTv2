const encoder = new TextEncoder();

export const CAPABILITY_VERSION = "ott-cap-v1";
export const CAPABILITY_TTL_MS = 60_000;

export type CapabilityPayload = {
  v: typeof CAPABILITY_VERSION;
  allocationId: string;
  roomId: string;
  purpose: "game-init" | "attach" | "seat-update" | "lifecycle";
  seat: "A" | "B";
  revision?: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export interface CapabilityTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<void>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

export type CapabilityTransactionRunner = <T>(callback: (storage: CapabilityTransaction) => Promise<T>) => Promise<T>;

export type CapabilityExpectations = {
  allocationId?: string;
  roomId: string;
  purpose: CapabilityPayload["purpose"];
  seat?: CapabilityPayload["seat"];
  revision?: number;
};

export type CapabilityFailureReason = "version" | "format" | "allocation" | "room" | "purpose" | "seat" | "revision" | "timestamps" | "lifetime" | "nonce" | "signature" | "replay" | "parse";
export type CapabilityVerification =
  | { ok: true; payload: CapabilityPayload }
  | { ok: false; reason: CapabilityFailureReason };

export type TransactionalCapabilityVerification<T> =
  | { ok: true; payload: CapabilityPayload; value: T }
  | { ok: false; reason: CapabilityFailureReason | "mutation-rejected" | "transaction-failed"; value?: T };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonical(payload: CapabilityPayload): string {
  const fields: unknown[] = [
    payload.v, payload.allocationId, payload.roomId, payload.purpose,
    payload.seat, payload.issuedAt, payload.expiresAt, payload.nonce,
  ];
  if (payload.revision !== undefined) fields.push(payload.revision);
  return JSON.stringify(fields);
}

export async function applySeatUpdateReceipt(
  storage: CapabilityTransaction,
  input: { allocationId: string; roomId: string; seat: "B"; name: string },
): Promise<"created" | "retry" | "conflict"> {
  if (await storage.get<string>("allocationId") !== input.allocationId || await storage.get<string>("roomId") !== input.roomId) return "conflict";
  const key = `seat-name:${input.seat}`;
  const previous = await storage.get<string>(key);
  if (previous !== undefined) return previous === input.name ? "retry" : "conflict";
  await storage.put(key, input.name);
  return "created";
}

export async function applyLifecycleUpdate(
  storage: CapabilityTransaction,
  input: { allocationId: string; roomId: string; revision: number; status: "waiting" | "playing" | "terminal" },
): Promise<"applied" | "stale" | "future" | "conflict"> {
  if (!Number.isInteger(input.revision) || input.revision < 1) return "conflict";
  const allocationKey = `allocation:${input.allocationId}`;
  const allocation = await storage.get<{ id: string; roomId: string; status: string }>(allocationKey);
  if (!allocation || allocation.roomId !== input.roomId) return "conflict";
  const key = `lifecycle:${input.allocationId}`;
  const previous = await storage.get<{ revision: number; status: string }>(key) ?? { revision: 0, status: "initializing" };
  if (input.revision <= previous.revision) return "stale";
  if (input.revision !== previous.revision + 1) return "future";
  const allowed = previous.status === "initializing"
    ? ["waiting", "playing", "terminal"]
    : previous.status === "waiting"
      ? ["waiting", "playing", "terminal"]
      : previous.status === "playing"
        ? ["playing", "terminal"]
        : previous.status === "terminal"
          ? ["terminal"]
          : [];
  if (!allowed.includes(input.status)) return "conflict";
  allocation.status = input.status;
  await storage.put(allocationKey, allocation);
  await storage.put(key, { revision: input.revision, status: input.status });
  if (input.status === "terminal") await deleteOwnerCredentials(storage, input.allocationId);
  return "applied";
}

/** Immutable initialization fields are receipt-bound; capabilities are not. */
export async function initializationPayloadHash(input: {
  allocationId: string;
  roomId: string;
  creatorName: string;
  creatorAttachDeadlineMs: number;
}): Promise<string> {
  const bytes = encoder.encode(JSON.stringify([
    input.allocationId,
    input.roomId,
    input.creatorName,
    input.creatorAttachDeadlineMs,
  ]));
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export type InitializationReceipt = { allocationId: string; roomId: string; payloadHash: string };

export type OwnerCredentialRecord = { salt: string; hash: string };
export type OwnerTicketRecord = { nonce: string; expiresAt: number };

/** Remove every per-seat owner secret when an allocation is rolled back or terminalized. */
export async function deleteOwnerCredentials(storage: CapabilityTransaction, allocationId: string): Promise<void> {
  if (!storage.delete) throw new Error("Owner credential cleanup requires transactional delete support");
  for (const seat of ["A", "B"] as const) {
    await storage.delete(`owner-credential:${allocationId}:${seat}`);
    await storage.delete(`owner-ticket:${allocationId}:${seat}`);
  }
}

function randomBase64url(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createCapabilityNonce(): string {
  return randomBase64url(18);
}

async function ownerCredentialHash(credential: string, salt: string): Promise<string> {
  const bytes = encoder.encode(`${salt}:${credential}`);
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Create a client secret and its salted server-side hash. */
export async function createOwnerCredential(): Promise<{ credential: string } & OwnerCredentialRecord> {
  const credential = randomBase64url(32);
  const salt = randomBase64url(16);
  const hash = await ownerCredentialHash(credential, salt);
  return { credential, salt, hash };
}

/** Compare a submitted opaque credential against its salted hash. */
export async function verifyOwnerCredential(credential: string, record: OwnerCredentialRecord): Promise<boolean> {
  const validShape = typeof credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(credential) &&
    typeof record?.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(record.salt) &&
    typeof record?.hash === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.hash);
  const candidate = await ownerCredentialHash(typeof credential === "string" ? credential : "", typeof record?.salt === "string" ? record.salt : "");
  const expected = typeof record?.hash === "string" ? record.hash : "";
  return constantTimeStringEqual(candidate, expected) && validShape;
}

/** Rotate one owner's credential and issue/store its next one-use attach ticket atomically. */
export async function rotateOwnerCredential(
  storage: CapabilityTransaction,
  secret: string,
  input: { allocationId: string; roomId: string; seat: CapabilityPayload["seat"]; resumeCredential: string; now?: number },
): Promise<{ seat: CapabilityPayload["seat"]; resumeCredential: string; ticket: string } | null> {
  const credentialKey = `owner-credential:${input.allocationId}:${input.seat}`;
  const previous = await storage.get<OwnerCredentialRecord>(credentialKey);
  if (!previous || !(await verifyOwnerCredential(input.resumeCredential, previous))) return null;

  const now = input.now ?? Date.now();
  const replacement = await createOwnerCredential();
  const nonce = randomBase64url(18);
  const ticket = await issueCapability(secret, {
    allocationId: input.allocationId,
    roomId: input.roomId,
    purpose: "attach",
    seat: input.seat,
    now,
    ttlMs: CAPABILITY_TTL_MS,
    nonce,
  });
  await storage.put(credentialKey, { salt: replacement.salt, hash: replacement.hash });
  await storage.put(`owner-ticket:${input.allocationId}:${input.seat}`, { nonce, expiresAt: now + CAPABILITY_TTL_MS } satisfies OwnerTicketRecord);
  return { seat: input.seat, resumeCredential: replacement.credential, ticket };
}

/** Persist one immutable initialization receipt, allowing only an exact retry. */
export async function applyInitializationReceipt(
  storage: CapabilityTransaction,
  input: InitializationReceipt,
  create: (storage: CapabilityTransaction) => Promise<void>,
): Promise<"created" | "retry" | "conflict"> {
  const key = "initialization-receipt";
  const previous = await storage.get<InitializationReceipt>(key);
  if (previous) {
    return previous.allocationId === input.allocationId && previous.roomId === input.roomId && previous.payloadHash === input.payloadHash
      ? "retry"
      : "conflict";
  }
  await create(storage);
  await storage.put(key, input);
  return "created";
}

/** Run Lobby initialization and remove its pending allocation on any failure. */
export async function withInitializationRollback<T>(
  initialize: () => Promise<T>,
  rollback: () => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false; rollbackSucceeded: boolean }> {
  try {
    return { ok: true, value: await initialize() };
  } catch {
    try {
      await rollback();
      return { ok: false, rollbackSucceeded: true };
    } catch {
      return { ok: false, rollbackSucceeded: false };
    }
  }
}

/** Roll a B-seat reservation back if Lobby cannot publish the completed join. */
export async function withJoinReservationRollback<T>(
  commit: () => Promise<T>,
  rollback: () => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false; rollbackSucceeded: boolean }> {
  try {
    return { ok: true, value: await commit() };
  } catch {
    try {
      await rollback();
      return { ok: false, rollbackSucceeded: true };
    } catch {
      return { ok: false, rollbackSucceeded: false };
    }
  }
}

/** Retry one transient Game seat-update request with a freshly issued capability. */
export async function retrySeatUpdateRequest<T>(
  request: (attempt: 0 | 1) => Promise<T>,
  retryableResult: (result: T) => boolean,
): Promise<T> {
  let first: T;
  try {
    first = await request(0);
  } catch {
    return request(1);
  }
  return retryableResult(first) ? request(1) : first;
}

/** Retry exactly once after a classified transient request failure. */
export async function retryRecoverableInitialization<T>(
  request: () => Promise<T>,
  retryableResult: (result: T) => boolean,
  recoverableError: (error: unknown) => boolean,
): Promise<T> {
  try {
    const result = await request();
    if (!retryableResult(result)) return result;
  } catch (error) {
    if (!recoverableError(error)) throw error;
  }
  return request();
}

function parseCanonical(value: string): CapabilityPayload {
  const fields = JSON.parse(value);
  if (!Array.isArray(fields) || (fields.length !== 8 && fields.length !== 9)) throw new Error("Invalid capability payload");
  const [v, allocationId, roomId, purpose, seat, issuedAt, expiresAt, nonce, revision] = fields;
  return { v, allocationId, roomId, purpose, seat, issuedAt, expiresAt, nonce, ...(revision === undefined ? {} : { revision }) } as CapabilityPayload;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueCapability(
  secret: string,
  input: Omit<CapabilityPayload, "v" | "issuedAt" | "expiresAt" | "nonce"> & { now?: number; ttlMs?: number; nonce?: string },
): Promise<string> {
  const issuedAt = input.now ?? Date.now();
  const payload: CapabilityPayload = {
    v: CAPABILITY_VERSION,
    allocationId: input.allocationId,
    roomId: input.roomId,
    purpose: input.purpose,
    seat: input.seat,
    issuedAt,
    expiresAt: issuedAt + (input.ttlMs ?? CAPABILITY_TTL_MS),
    nonce: input.nonce ?? createCapabilityNonce(),
  };
  const encoded = base64url(encoder.encode(canonical(payload)));
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret), encoder.encode(encoded));
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyCapability(
  secret: string,
  token: string,
  expected: CapabilityExpectations,
  now = Date.now(),
): Promise<CapabilityPayload | null> {
  const result = await verifyCapabilityDetailed(secret, token, expected, now);
  return result.ok ? result.payload : null;
}

export async function verifyCapabilityDetailed(
  secret: string,
  token: string,
  expected: CapabilityExpectations,
  now = Date.now(),
): Promise<CapabilityVerification> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return { ok: false, reason: "format" };
    const encoded = parts[0];
    const payload = parseCanonical(new TextDecoder().decode(fromBase64url(encoded)));
    if (payload.v !== CAPABILITY_VERSION) return { ok: false, reason: "version" };
    if (expected.allocationId !== undefined && payload.allocationId !== expected.allocationId) return { ok: false, reason: "allocation" };
    if (payload.roomId !== expected.roomId) return { ok: false, reason: "room" };
    if (payload.purpose !== expected.purpose) return { ok: false, reason: "purpose" };
    if (!["A", "B"].includes(payload.seat)) return { ok: false, reason: "seat" };
    if (expected.seat !== undefined && payload.seat !== expected.seat) return { ok: false, reason: "seat" };
    if ((payload.purpose === "lifecycle" && (!Number.isInteger(payload.revision) || payload.revision! < 1)) ||
      (payload.purpose !== "lifecycle" && payload.revision !== undefined) ||
      (expected.revision !== undefined && payload.revision !== expected.revision)) return { ok: false, reason: "revision" };
    if (!Number.isInteger(payload.issuedAt) || !Number.isInteger(payload.expiresAt) || payload.expiresAt <= now || payload.issuedAt > now) return { ok: false, reason: "timestamps" };
    if (payload.expiresAt <= payload.issuedAt) return { ok: false, reason: "timestamps" };
    if (payload.expiresAt - payload.issuedAt > CAPABILITY_TTL_MS) return { ok: false, reason: "lifetime" };
    if (typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)) return { ok: false, reason: "nonce" };
    const valid = await crypto.subtle.verify("HMAC", await keyFor(secret), fromBase64url(parts[1]), encoder.encode(encoded));
    if (!valid) return { ok: false, reason: "signature" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

/** Verify a signed capability, then consume its nonce and apply its mutation atomically. */
export async function verifyCapabilityTransaction<T>(
  secret: string,
  token: string,
  expected: CapabilityExpectations,
  transaction: CapabilityTransactionRunner,
  mutate: (payload: CapabilityPayload, storage: CapabilityTransaction) => Promise<{ accepted: boolean; value: T }>,
  options: { now?: number; noncePrefix?: string } = {},
): Promise<TransactionalCapabilityVerification<T>> {
  const verification = await verifyCapabilityDetailed(secret, token, expected, options.now ?? Date.now());
  if (!verification.ok) return verification;
  const prefix = options.noncePrefix ?? "nonce";
  try {
    return await transaction(async (storage) => {
      const nonceKey = `${prefix}:${verification.payload.nonce}`;
      if (await storage.get<number>(nonceKey) !== undefined) return { ok: false, reason: "replay" };
      const result = await mutate(verification.payload, storage);
      if (!result.accepted) throw { capabilityMutationRejected: true, value: result.value };
      await storage.put(nonceKey, verification.payload.expiresAt);
      return { ok: true, payload: verification.payload, value: result.value };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "capabilityMutationRejected" in error && error.capabilityMutationRejected === true) {
      return { ok: false, reason: "mutation-rejected", value: error.value as T };
    }
    console.warn("OTT capability transaction failed", error instanceof Error ? error.message : typeof error);
    return { ok: false, reason: "transaction-failed" };
  }
}

export interface AttachRecoveryAdapter<C, T extends { ok?: boolean }> {
  attach(connection: C, seat: CapabilityPayload["seat"], name: string | undefined, storage: CapabilityTransaction): Promise<T>;
  forget(connection: C): void;
  reloadPersisted(): Promise<void>;
  scheduleAlarm(storage?: CapabilityTransaction): Promise<void>;
}

/** Keep attach mutation, nonce, and adapter recovery on one verified path. */
export async function attachWithCapabilityRecovery<C, T extends { ok?: boolean }>(
  secret: string,
  token: string,
  expected: CapabilityExpectations,
  transaction: CapabilityTransactionRunner,
  adapter: AttachRecoveryAdapter<C, T>,
  connection: C,
): Promise<TransactionalCapabilityVerification<T>> {
  const result = await verifyCapabilityTransaction(secret, token, expected, transaction, async (payload, storage) => {
    const attached = await adapter.attach(connection, payload.seat, undefined, storage);
    if (attached?.ok === true) await adapter.scheduleAlarm(storage);
    return { accepted: attached?.ok === true, value: attached };
  }, { noncePrefix: "attach-nonce" });
  if (!result.ok && (result.reason === "transaction-failed" || result.reason === "mutation-rejected")) {
    adapter.forget(connection);
    await adapter.reloadPersisted();
  }
  return result;
}

export function internalRequest(secret: string, path: string, body: unknown): Request {
  return new Request(`https://ott.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": secret },
    body: JSON.stringify(body),
  });
}
