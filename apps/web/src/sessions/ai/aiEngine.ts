import type { AiLevel } from "../../shared/model/aiLevel";
import type { CoreMove, CoreState } from "../core/gameCoreBridge";
import type { Seat } from "../../shared/model/game";

/** Chooses a move off the render path; the state it receives is never mutated. */
export interface AiEngine {
  choose(state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null>;
  dispose(): void;
}

type Pending = { resolve: (move: CoreMove | null) => void; reject: (error: unknown) => void };

/** Runs the canonical core AI in a Web Worker so deep searches do not freeze the board. */
export class WorkerAiEngine implements AiEngine {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./ai.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<{ id: number; move?: CoreMove | null; error?: string }>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data.move ?? null);
    };
    this.worker.onerror = () => this.failAll(new Error("ai_worker_failed"));
  }

  choose(state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, state, player, level });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.failAll(new Error("ai_engine_disposed"));
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

/** Same search on the calling thread; used when Web Workers are unavailable. */
export class InlineAiEngine implements AiEngine {
  async choose(state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null> {
    const ai = globalThis.OTT_AI;
    return ai ? ai.chooseMove(state, player, { level }) : null;
  }

  dispose(): void {}
}

export function createAiEngine(): AiEngine {
  if (typeof Worker === "undefined") return new InlineAiEngine();
  try { return new WorkerAiEngine(); } catch { return new InlineAiEngine(); }
}
