import "../../../../../vendor/playhtml-minimal/browser/runtime.js";
import "../../../../../packages/game-client/src/playhtml-bootstrap.js";
import "../../../../../packages/game-client/src/playhtml-game-client.js";

import type { OnlineConnection } from "./globals";

export interface RuntimeConfig {
  readonly host: string;
  readonly room: string;
}

export interface RuntimeBridge {
  readonly bootstrap: (config: RuntimeConfig) => Promise<unknown>;
  readonly connectionFactory: () => OnlineConnection;
}

export interface RuntimeBridgeDependencies {
  readonly runtime?: NonNullable<typeof globalThis.OTT_PLAYHTML_RUNTIME>;
  readonly bootstrapFactory?: NonNullable<typeof globalThis.PlayhtmlBootstrap>;
  readonly globalObject?: typeof globalThis;
}

export function createRuntimeBridge(deps: RuntimeBridgeDependencies = {}): RuntimeBridge {
  const target = deps.globalObject ?? globalThis;
  const runtime = deps.runtime ?? target.OTT_PLAYHTML_RUNTIME;
  const bootstrapApi = deps.bootstrapFactory ?? target.PlayhtmlBootstrap;
  let initialized: Promise<unknown> | null = null;
  let bound: RuntimeConfig | null = null;
  let ready = false;

  const bootstrap = async (config: RuntimeConfig): Promise<unknown> => {
    if (!config || typeof config.host !== "string" || typeof config.room !== "string" || !config.host || !config.room) {
      throw new Error("PlayHTML requires a host and room");
    }
    if (bound && (bound.host !== config.host || bound.room !== config.room)) {
      throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
    }
    if (!initialized) {
      bound = { host: config.host, room: config.room };
      if (!runtime || !bootstrapApi) {
        initialized = Promise.reject(new Error("PlayHTML runtime is unavailable"));
      } else {
        const pageBootstrap = bootstrapApi.createBootstrap({ runtime, globalObject: target });
        initialized = Promise.resolve(pageBootstrap(config)).then((value) => {
          ready = true;
          return value;
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

  return { bootstrap, connectionFactory };
}

export const runtimeBridge = createRuntimeBridge();
