import type { EnginePort } from "../../../arena/src/ports/index.d.mts";

export declare function createNodeEngine(options?: {
  rules?: unknown;
  config?: unknown;
}): EnginePort;

export declare const coreRules: unknown;
export declare const coreConfig: unknown;
