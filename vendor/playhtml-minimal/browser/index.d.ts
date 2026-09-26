export interface CustomMessageChannel {
  send(message: string): Promise<void>;
  subscribe(listener: (message: string) => void): () => void;
  close(): void;
}

export interface MinimalPlayhtml {
  readonly ready: Promise<unknown>;
  createCustomMessageChannel(): CustomMessageChannel;
}

export interface MinimalProvider {
  sendMessage(message: string): void;
  on(event: "custom-message", listener: (message: unknown) => void): (() => void) | void;
}

export function createMinimalPlayhtml(options: {
  ready: Promise<unknown>;
  provider: MinimalProvider;
}): MinimalPlayhtml;
