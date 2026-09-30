import type { Position, Seat } from "../../shared/model/game";

export interface OnlineConnection {
  on(event: "open" | "close" | "reconnecting" | "resumed" | "error" | "message", listener: (payload?: unknown) => void): void;
  send(message: unknown): void | Promise<void>;
  connect?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface PlayhtmlAllocation {
  readonly allocationId: string;
  readonly room: string;
  readonly seat: Seat;
  readonly ticket: string;
  readonly resumeCredential: string;
}

export interface PlayhtmlSpectatorAllocation {
  readonly allocationId: string;
  readonly room: string;
  readonly ticket: string;
}

export interface PlayhtmlGameClientLike {
  on(event: string, listener: (payload?: any) => void): (() => void) | void;
  attachAllocation(allocation: PlayhtmlAllocation): Promise<unknown>;
  move(from: Position, to: Position): boolean;
  leave(): boolean;
  close(): void;
  roomId?: string | null;
  you?: Seat | null;
}

export interface PlayhtmlGameClientConstructor {
  new (options: {
    connectionFactory: () => OnlineConnection;
    controlRequest?: (action: string, body?: unknown) => Promise<unknown>;
    playhtmlBootstrap?: (config: { host: string; room: string }) => Promise<unknown>;
    playhtmlHost?: string;
  }): PlayhtmlGameClientLike;
}

export interface PlayhtmlRuntimeLike {
  configure(options: { host: string; room: string; party?: "main" | "lobby" }): void;
  init(): { readonly ready: Promise<unknown>; createCustomMessageChannel(): unknown; close?(): void };
  reset?(): Promise<void> | void;
}

export interface PlayhtmlBootstrapInstance {
  (config: { host: string; room: string; party?: "main" | "lobby" }): Promise<unknown>;
  bootstrap?(config: { host: string; room: string; party?: "main" | "lobby" }): Promise<unknown>;
  dispose?(): Promise<void> | void;
}

export interface PlayhtmlBootstrapLike {
  createBootstrap(options: { runtime: PlayhtmlRuntimeLike; globalObject?: typeof globalThis }): PlayhtmlBootstrapInstance;
}

declare global {
  var PlayhtmlGameClient: PlayhtmlGameClientConstructor | undefined;
  var PlayhtmlBootstrap: PlayhtmlBootstrapLike | undefined;
  var OTT_PLAYHTML_RUNTIME: PlayhtmlRuntimeLike | undefined;
  var OTT_PLAYHTML_CONTROL_ENDPOINT: string | undefined;
  var OTT_PLAYHTML_HOST: string | undefined;
  var OTT_PLAYHTML_BOOTSTRAP: ((config: { host: string; room: string }) => Promise<unknown>) | undefined;
  var OTT_PLAYHTML_CONNECTION_FACTORY: (() => OnlineConnection) | undefined;
}

export {};
