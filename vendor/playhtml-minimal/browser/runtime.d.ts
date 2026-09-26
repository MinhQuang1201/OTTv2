export interface MinimalPlayhtml {
  readonly ready: Promise<void>;
  createCustomMessageChannel(): {
    send(message: string): Promise<void>;
    subscribe(listener: (message: string) => void): () => void;
    close(): void;
  };
  close(): void;
}

export interface MinimalPlayhtmlRuntime {
  configure(options: { host: string; room: string }): void;
  init(): MinimalPlayhtml;
}

declare global {
  interface Window {
    OTT_PLAYHTML_RUNTIME: MinimalPlayhtmlRuntime;
  }
}

export declare const runtime: MinimalPlayhtmlRuntime;
