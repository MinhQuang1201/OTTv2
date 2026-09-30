import "../../../../../vendor/playhtml-minimal/browser/runtime.js";
import "../../../../../packages/game-client/src/playhtml-bootstrap.js";
import "../../../../../packages/game-client/src/playhtml-game-client.js";

import type { OnlineConnection } from "./globals";

export interface RuntimeConfig {
  readonly host: string;
  readonly room: string;
  readonly party?: "main" | "lobby";
}

export interface RuntimeBridge {
  readonly bootstrap: (config: RuntimeConfig) => Promise<unknown>;
  readonly connectionFactory: () => OnlineConnection;
  readonly dispose: () => Promise<void>;
}

export type RuntimeLifecycleOwner = RuntimeBridge;

export interface RuntimeBridgeDependencies {
  /** Reuse an App-owned lifecycle instead of creating a second runtime owner. */
  readonly lifecycleOwner?: RuntimeLifecycleOwner;
  readonly runtime?: NonNullable<typeof globalThis.OTT_PLAYHTML_RUNTIME>;
  readonly bootstrapFactory?: NonNullable<typeof globalThis.PlayhtmlBootstrap>;
  readonly globalObject?: typeof globalThis;
}

export function createRuntimeBridge(deps: RuntimeBridgeDependencies = {}): RuntimeBridge {
  if (deps.lifecycleOwner) return deps.lifecycleOwner;
  const target = deps.globalObject ?? globalThis;
  const runtime = deps.runtime ?? target.OTT_PLAYHTML_RUNTIME;
  const bootstrapApi = deps.bootstrapFactory ?? target.PlayhtmlBootstrap;
  let initialized: Promise<unknown> | null = null;
  let bound: RuntimeConfig | null = null;
  let ready = false;
  let pageBootstrapInstance: { dispose?: () => Promise<void> | void } | null = null;
  let epoch = 0;
  let disposing: Promise<void> | null = null;

  const bootstrap = async (config: RuntimeConfig): Promise<unknown> => {
    if (!config || typeof config.host !== "string" || typeof config.room !== "string" || !config.host || !config.room) {
      throw new Error("PlayHTML requires a host and room");
    }
    while (disposing) {
      try {
        await disposing;
      } catch {
        // ignore
      }
    }
    if (bound && (bound.host !== config.host || bound.room !== config.room || bound.party !== config.party)) {
      throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
    }
    if (!initialized) {
      const currentEpoch = ++epoch;
      bound = { host: config.host, room: config.room, party: config.party };
      if (!runtime || !bootstrapApi) {
        initialized = Promise.reject(new Error("PlayHTML runtime is unavailable")).catch((err) => {
          if (epoch === currentEpoch) {
            bound = null;
            initialized = null;
          }
          throw err;
        });
      } else {
        const pageBootstrap = bootstrapApi.createBootstrap({ runtime, globalObject: target });
        pageBootstrapInstance = pageBootstrap;
        const runner = typeof pageBootstrap.bootstrap === "function" ? pageBootstrap.bootstrap.bind(pageBootstrap) : pageBootstrap;
        initialized = Promise.resolve(runner(config))
          .then((value) => {
            if (epoch !== currentEpoch) {
              throw new Error("PlayHTML bootstrap was aborted");
            }
            ready = true;
            return value;
          })
          .catch(async (err) => {
            if (epoch === currentEpoch) {
              ready = false;
              bound = null;
              initialized = null;
              const instance = pageBootstrapInstance;
              pageBootstrapInstance = null;
              if (instance && typeof instance.dispose === "function") {
                const disposeFn = instance.dispose;
                const cleanupPromise = (async () => {
                  try {
                    await disposeFn();
                  } catch {
                    // ignore disposal errors
                  }
                })();
                disposing = cleanupPromise;
                try {
                  await cleanupPromise;
                } finally {
                  if (disposing === cleanupPromise) {
                    disposing = null;
                  }
                }
              }
              throw err;
            }
            throw new Error("PlayHTML bootstrap was aborted");
          });
      }
    }
    return initialized;
  };

  const connectionFactory = (): OnlineConnection => {
    if (!ready) throw new Error("PlayHTML connection is not ready");
    const factory = target.OTT_PLAYHTML_CONNECTION_FACTORY;
    if (typeof factory !== "function") throw new Error("PlayHTML connection is not ready");
    return factory();
  };

  const dispose = async (): Promise<void> => {
    epoch += 1;
    ready = false;
    bound = null;
    initialized = null;
    const instanceToDispose = pageBootstrapInstance;
    pageBootstrapInstance = null;

    if (disposing) {
      if (instanceToDispose && typeof instanceToDispose.dispose === "function") {
        try {
          await instanceToDispose.dispose();
        } catch {
          // ignore disposal errors
        }
      }
      try {
        await disposing;
      } catch {
        // ignore
      }
      return;
    }

    const currentDisposal = (async () => {
      if (instanceToDispose && typeof instanceToDispose.dispose === "function") {
        try {
          await instanceToDispose.dispose();
        } catch {
          // ignore disposal errors
        }
      }
    })();
    disposing = currentDisposal;
    try {
      await currentDisposal;
    } finally {
      if (disposing === currentDisposal) {
        disposing = null;
      }
    }
  };

  return { bootstrap, connectionFactory, dispose };
}

export const runtimeBridge = createRuntimeBridge();
