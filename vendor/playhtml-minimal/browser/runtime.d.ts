export interface MinimalPlayhtml {
  readonly ready: Promise<void>;
  readonly provider?: unknown;
  createCustomMessageChannel(): {
    send(message: string): Promise<void>;
    subscribe(listener: (message: string) => void): () => void;
    close(): void;
  };
  close(): void;
}

export interface MinimalPlayhtmlRuntime {
  configure(options: { host: string; room: string; party?: "main" | "lobby" }): void;
  init(): MinimalPlayhtml;
  reset?(): Promise<void> | void;
}

declare global {
  interface Window {
    OTT_PLAYHTML_RUNTIME: MinimalPlayhtmlRuntime;
  }
}

export declare const runtime: MinimalPlayhtmlRuntime;
