import {
  parsePublicMatchCatalog,
  validatePublicMatchCatalog,
  type PublicMatchCatalogMessage,
  type PublicMatchView,
} from "../../../../../packages/protocol/src/index";
import type { OnlineConnection } from "./globals";
import { createRuntimeBridge, type RuntimeBridge } from "./runtimeBridge";

export type OnlineLobbyStreamStatus = "loading" | "ready" | "unavailable" | "error" | "reconnecting";

export interface OnlineLobbyStreamSnapshot {
  readonly status: OnlineLobbyStreamStatus;
  readonly matches: readonly PublicMatchView[];
  readonly catalogRevision: number;
  readonly message?: string;
}

export interface OnlineLobbyStreamOptions {
  readonly runtime?: RuntimeBridge;
  readonly host?: string;
  readonly maxReconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
  readonly disposeRuntime?: boolean;
}

const LOBBY_CONFIG = {
  room: "ott-lobby-public",
  party: "lobby" as const,
};
const EMPTY_MATCHES: readonly PublicMatchView[] = Object.freeze([]);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const UNAVAILABLE_ERRORS = new Set(["spectator_disabled", "active_matches_unavailable", "room_unavailable", "unavailable"]);

type IncomingLobbyMessage = PublicMatchCatalogMessage | { readonly __ott: true; readonly type: "ott:error"; readonly error: string };

interface ConnectionAttempt {
  readonly connection: OnlineConnection;
  readonly lifecycleGeneration: number;
  readonly opening: Promise<void>;
  readonly resolveOpening: () => void;
  readonly rejectOpening: (error: unknown) => void;
  settled: boolean;
}

function messageFrom(error: unknown, fallback: string): string {
  return error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : fallback;
}

function immutableMatches(matches: readonly PublicMatchView[]): readonly PublicMatchView[] {
  return Object.freeze(matches.map((match) => Object.freeze({
    ...match,
    players: Object.freeze({
      A: Object.freeze({ ...match.players.A }),
      B: Object.freeze({ ...match.players.B }),
    }),
  })));
}

function parseIncomingMessage(payload: unknown): IncomingLobbyMessage | null {
  if (typeof payload === "string") {
    const value = payload.startsWith("__YPS:") ? payload.slice("__YPS:".length) : payload;
    const result = parsePublicMatchCatalog(value);
    if (result.ok) return result.value;
    try {
      const parsed: unknown = JSON.parse(value);
      if (isLobbyError(parsed)) return parsed;
    } catch {
      // Ignore malformed transport payloads.
    }
    return null;
  }
  const result = validatePublicMatchCatalog(payload);
  if (result.ok) return result.value;
  return isLobbyError(payload) ? payload : null;
}

function isLobbyError(value: unknown): value is Extract<IncomingLobbyMessage, { type: "ott:error" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).sort().join(",") === "__ott,error,type" &&
    object.__ott === true && object.type === "ott:error" && typeof object.error === "string" && object.error.length > 0;
}

export class OnlineLobbyStream {
  private readonly runtime: RuntimeBridge;
  private readonly host: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly disposeRuntime: boolean;
  private readonly listeners = new Set<() => void>();
  private snapshot: OnlineLobbyStreamSnapshot = Object.freeze({
    status: "loading",
    matches: EMPTY_MATCHES,
    catalogRevision: -1,
  });
  private connection: OnlineConnection | null = null;
  private readonly ownedConnections = new Set<OnlineConnection>();
  private readonly closedConnections = new WeakSet<object>();
  private readonly closingConnections = new WeakMap<object, Promise<void>>();
  private connectionOpened = false;
  private hasOpened = false;
  private openingFailed = false;
  private subscribedGeneration = 0;
  private connectionGeneration = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private opening: Promise<void> | null = null;
  private activeAttempt: ConnectionAttempt | null = null;
  private readonly reconnectOperations = new Set<Promise<void>>();
  private started = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private lifecycleGeneration = 0;

  constructor(options: OnlineLobbyStreamOptions = {}) {
    this.runtime = options.runtime ?? createRuntimeBridge();
    this.host = options.host ?? globalThis.OTT_PLAYHTML_HOST ?? globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT ?? "";
    this.maxReconnectAttempts = Number.isInteger(options.maxReconnectAttempts) && (options.maxReconnectAttempts as number) >= 0
      ? options.maxReconnectAttempts as number
      : DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = Number.isFinite(options.reconnectDelayMs) && (options.reconnectDelayMs as number) >= 0
      ? options.reconnectDelayMs as number
      : DEFAULT_RECONNECT_DELAY_MS;
    this.disposeRuntime = options.disposeRuntime !== false;
  }

  getSnapshot = (): OnlineLobbyStreamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.disposed || this.started) {
      if (this.opening) await this.opening;
      return;
    }
    this.started = true;
    const lifecycleGeneration = ++this.lifecycleGeneration;
    this.setSnapshot({ status: "loading", matches: EMPTY_MATCHES, catalogRevision: -1, message: undefined });

    try {
      if (!this.host) throw new Error("PlayHTML host is unavailable");
      await this.runtime.bootstrap({ host: this.host, ...LOBBY_CONFIG });
      if (!this.isCurrent(lifecycleGeneration)) return;
      const connection = this.runtime.connectionFactory();
      if (!this.isConnection(connection)) {
        throw new Error("PlayHTML lobby connection adapter is invalid");
      }
      this.connection = connection;
      this.ownedConnections.add(connection);
      this.openingFailed = false;
      this.bindConnection(connection, lifecycleGeneration);
      await this.openConnection(connection, lifecycleGeneration, true);
    } catch (error) {
      if (!this.isCurrent(lifecycleGeneration) || this.hasOpened) return;
      await this.closeConnection(this.connection);
      this.connection = null;
      this.setSnapshot({ status: "unavailable", matches: EMPTY_MATCHES, catalogRevision: -1, message: messageFrom(error, "Online hiện không khả dụng.") });
    }
  }

  dispose = (): Promise<void> => {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.started = false;
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.activeAttempt?.rejectOpening(new Error("PlayHTML lobby stream disposed"));
    this.activeAttempt = null;
    this.opening = null;
    this.connection = null;
    this.connectionOpened = false;
    this.openingFailed = true;

    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    const disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    this.disposal = disposal;
    let publishFailed = false;
    let publishError: unknown;
    try {
      this.setSnapshot({ status: "unavailable", matches: EMPTY_MATCHES, catalogRevision: -1, message: undefined });
    } catch (error) {
      publishFailed = true;
      publishError = error;
    }
    void (async () => {
      let cleanupFailed = false;
      let cleanupError: unknown;
      try {
        await this.closeOwnedConnections();
        await Promise.all([...this.reconnectOperations]);
        await this.closeOwnedConnections();
        if (this.disposeRuntime) await this.runtime.dispose();
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      } finally {
        this.listeners.clear();
      }
      if (publishFailed) rejectDisposal(publishError);
      else if (cleanupFailed) rejectDisposal(cleanupError);
      else resolveDisposal();
    })();
    return disposal;
  }

  private bindConnection(connection: OnlineConnection, lifecycleGeneration: number): void {
    connection.on("open", () => {
      if (this.isCurrentConnection(connection, lifecycleGeneration)) this.handleOpen(connection, lifecycleGeneration);
    });
    connection.on("reconnecting", () => {
      if (!this.isCurrentConnection(connection, lifecycleGeneration)) return;
      if (!this.hasOpened) {
        this.failOpening(new Error("PlayHTML lobby connection is reconnecting before opening"));
        return;
      }
      this.activeAttempt?.rejectOpening(new Error("PlayHTML lobby connection is reconnecting"));
      this.connectionOpened = false;
      this.subscribedGeneration = 0;
      this.setSnapshot({ status: "reconnecting", message: undefined });
      this.scheduleReconnect(connection, lifecycleGeneration);
    });
    connection.on("close", () => {
      if (!this.isCurrentConnection(connection, lifecycleGeneration)) return;
      if (!this.hasOpened) {
        this.failOpening(new Error("PlayHTML lobby connection closed before opening"));
        return;
      }
      this.activeAttempt?.rejectOpening(new Error("PlayHTML lobby connection closed while reconnecting"));
      this.connectionOpened = false;
      this.subscribedGeneration = 0;
      this.setSnapshot({ status: "reconnecting", message: undefined });
      this.scheduleReconnect(connection, lifecycleGeneration);
    });
    connection.on("error", (error) => {
      if (!this.isCurrentConnection(connection, lifecycleGeneration)) return;
      if (!this.hasOpened) {
        this.failOpening(error ?? new Error("PlayHTML lobby connection failed"));
        return;
      }
      this.activeAttempt?.rejectOpening(error ?? new Error("PlayHTML lobby connection failed"));
      this.connectionOpened = false;
      this.subscribedGeneration = 0;
      this.setSnapshot({ status: "error", message: messageFrom(error, "Online lobby stream gặp lỗi.") });
      this.scheduleReconnect(connection, lifecycleGeneration);
    });
  }

  private async openConnection(connection: OnlineConnection, lifecycleGeneration: number, initial: boolean): Promise<void> {
    let resolveOpening!: () => void;
    let rejectOpening!: (error: unknown) => void;
    const opening = new Promise<void>((resolve, reject) => {
      resolveOpening = () => {
        attempt.settled = true;
        resolve();
      };
      rejectOpening = (error) => {
        attempt.settled = true;
        reject(error);
      };
    });
    const attempt: ConnectionAttempt = {
      connection,
      lifecycleGeneration,
      opening,
      resolveOpening,
      rejectOpening,
      settled: false,
    };
    this.activeAttempt = attempt;
    this.opening = opening;
    try {
      if (typeof connection.connect === "function") {
        const connecting = Promise.resolve().then(() => connection.connect!());
        await Promise.race([connecting, opening]);
        if (!this.isCurrentAttempt(attempt) || attempt.settled) return;
        if (!this.connectionOpened) this.handleOpen(connection, lifecycleGeneration);
      }
      await opening;
    } catch (error) {
      if (this.isCurrentConnection(connection, lifecycleGeneration)) {
        if (!this.hasOpened) {
          if (!this.openingFailed) {
            this.openingFailed = true;
            this.setSnapshot({ status: "unavailable", message: messageFrom(error, "Online hiện không khả dụng.") });
          }
        } else {
          this.handleReconnectFailure(connection, lifecycleGeneration, error);
        }
      }
      if (initial && !this.hasOpened) throw error;
    } finally {
      if (this.activeAttempt === attempt) this.activeAttempt = null;
      if (this.opening === opening) this.opening = null;
    }
  }

  private handleOpen(connection: OnlineConnection, lifecycleGeneration: number): void {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.connection !== connection || attempt.lifecycleGeneration !== lifecycleGeneration ||
      this.connectionOpened || this.openingFailed || this.disposed || connection !== this.connection) return;
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionOpened = true;
    this.hasOpened = true;
    const generation = ++this.connectionGeneration;
    this.bindGenerationMessages(connection, lifecycleGeneration, generation);
    this.sendSubscribe(connection, generation, lifecycleGeneration, attempt);
  }

  private sendSubscribe(connection: OnlineConnection, generation: number, lifecycleGeneration: number, attempt: ConnectionAttempt): void {
    if (this.subscribedGeneration === generation) return;
    try {
      const result = connection.send({ __ott: true, type: "ott:lobby-subscribe" });
      void Promise.resolve(result).then(() => {
        if (!this.isCurrentAttempt(attempt) || !this.connectionOpened || this.connectionGeneration !== generation) return;
        this.subscribedGeneration = generation;
        this.reconnectAttempts = 0;
        attempt.resolveOpening();
        this.setSnapshot({ status: "ready", message: undefined });
      }).catch((error) => this.handleSubscribeFailure(connection, generation, lifecycleGeneration, attempt, error));
    } catch (error) {
      this.handleSubscribeFailure(connection, generation, lifecycleGeneration, attempt, error);
    }
  }

  private handleMessage(payload: unknown): void {
    const message = parseIncomingMessage(payload);
    if (!message) return;
    if (message.type === "ott:error") {
      const status = UNAVAILABLE_ERRORS.has(message.error) || message.error.includes("unavailable") ? "unavailable" : "error";
      if (!this.hasOpened) {
        this.failOpening(new Error(message.error));
        return;
      }
      this.setSnapshot({ status, message: message.error });
      return;
    }
    if (message.catalogRevision <= this.snapshot.catalogRevision) return;
    const matches = immutableMatches(message.matches);
    this.setSnapshot({ status: "ready", catalogRevision: message.catalogRevision, matches, message: undefined });
  }

  private scheduleReconnect(connection: OnlineConnection, lifecycleGeneration: number): void {
    if (this.reconnectTimer !== null || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) this.setSnapshot({ status: "error", message: "Không thể kết nối lại lobby stream." });
      return;
    }
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrentConnection(connection, lifecycleGeneration)) return;
      this.reconnectAttempts += 1;
      let resolveReconnect!: () => void;
      let rejectReconnect!: (error: unknown) => void;
      const reconnect = new Promise<void>((resolve, reject) => {
        resolveReconnect = resolve;
        rejectReconnect = reject;
      });
      this.reconnectOperations.add(reconnect);
      void (async () => {
        let nextConnection: OnlineConnection;
        try {
          nextConnection = this.runtime.connectionFactory();
          if (!this.isConnection(nextConnection) || nextConnection === connection) {
            throw new Error("PlayHTML lobby reconnect did not provide a new connection source");
          }
          this.ownedConnections.add(nextConnection);
          await this.closeConnection(connection);
          if (!this.isCurrent(lifecycleGeneration) || this.connection !== connection) {
            await this.closeConnection(nextConnection);
            return;
          }
        } catch (error) {
          this.handleReconnectFailure(connection, lifecycleGeneration, error);
          return;
        }
        this.connection = nextConnection;
        this.connectionOpened = false;
        this.subscribedGeneration = 0;
        this.bindConnection(nextConnection, lifecycleGeneration);
        void this.openConnection(nextConnection, lifecycleGeneration, false);
      })().then(resolveReconnect, rejectReconnect);
      void reconnect.then(
        () => this.reconnectOperations.delete(reconnect),
        () => this.reconnectOperations.delete(reconnect),
      );
    }, this.reconnectDelayMs);
  }

  private async closeConnection(connection: OnlineConnection | null): Promise<void> {
    if (!connection) return;
    const pending = this.closingConnections.get(connection);
    if (pending) {
      await pending;
      return;
    }
    if (this.closedConnections.has(connection)) return;
    this.closedConnections.add(connection);
    const closing = Promise.resolve()
      .then(() => connection.close?.())
      .then(() => undefined, () => undefined);
    this.closingConnections.set(connection, closing);
    await closing;
  }

  private async closeOwnedConnections(): Promise<void> {
    while (true) {
      const pending = [...this.ownedConnections]
        .filter((connection) => !this.closedConnections.has(connection))
        .map((connection) => this.closeConnection(connection));
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private handleReconnectFailure(connection: OnlineConnection, lifecycleGeneration: number, error: unknown): void {
    if (!this.isCurrentConnection(connection, lifecycleGeneration)) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setSnapshot({ status: "error", message: messageFrom(error, "Không thể kết nối lại lobby stream.") });
      return;
    }
    this.setSnapshot({ status: "reconnecting", message: messageFrom(error, "Đang kết nối lại lobby stream.") });
    this.scheduleReconnect(connection, lifecycleGeneration);
  }

  private handleSubscribeFailure(
    connection: OnlineConnection,
    generation: number,
    lifecycleGeneration: number,
    attempt: ConnectionAttempt,
    error: unknown,
  ): void {
    if (!this.isCurrentAttempt(attempt) || !this.connectionOpened || this.connectionGeneration !== generation) return;
    this.connectionOpened = false;
    this.subscribedGeneration = 0;
    this.setSnapshot({ status: "reconnecting", message: messageFrom(error, "Không thể đăng ký lobby stream.") });
    attempt.resolveOpening();
    this.scheduleReconnect(connection, lifecycleGeneration);
  }

  private failOpening(error: unknown): void {
    this.openingFailed = true;
    this.setSnapshot({ status: "unavailable", message: messageFrom(error, "Online hiện không khả dụng.") });
    this.activeAttempt?.rejectOpening(error ?? new Error("PlayHTML lobby connection failed"));
  }

  private isCurrent(lifecycleGeneration: number): boolean {
    return !this.disposed && lifecycleGeneration === this.lifecycleGeneration;
  }

  private isCurrentConnection(connection: OnlineConnection, lifecycleGeneration: number): boolean {
    return this.isCurrent(lifecycleGeneration) && connection === this.connection;
  }

  private isCurrentAttempt(attempt: ConnectionAttempt): boolean {
    return this.activeAttempt === attempt && this.isCurrentConnection(attempt.connection, attempt.lifecycleGeneration);
  }

  private isConnection(value: unknown): value is OnlineConnection {
    return Boolean(value) && typeof (value as OnlineConnection).on === "function" &&
      typeof (value as OnlineConnection).send === "function";
  }

  private bindGenerationMessages(connection: OnlineConnection, lifecycleGeneration: number, generation: number): void {
    connection.on("message", (payload) => {
      if (!this.isCurrentConnection(connection, lifecycleGeneration) || !this.isSubscribed(connection, generation)) return;
      this.handleMessage(payload);
    });
  }

  private isSubscribed(connection: OnlineConnection, generation: number): boolean {
    return connection === this.connection && this.connectionOpened && this.connectionGeneration > 0 &&
      this.connectionGeneration === generation && this.subscribedGeneration === generation;
  }

  private setSnapshot(change: Partial<OnlineLobbyStreamSnapshot>): void {
    if (this.disposed && change.status !== "unavailable") return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of [...this.listeners]) listener();
  }
}
