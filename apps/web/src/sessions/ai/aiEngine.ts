import type { AiLevel } from "../../shared/model/aiLevel";
import type { CoreMove, CoreState } from "../core/gameCoreBridge";
import type { Seat } from "../../shared/model/game";

/** Chooses a move off the render path; the state it receives is never mutated. */
export interface AiEngine {
  choose(state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null>;
  dispose(): void;
}

type Pending = { resolve: (move: CoreMove | null) => void; reject: (error: unknown) => void };

const WORKER_TIMEOUT_MS = 15_000;

/**
 * Runs the canonical core AI in a Web Worker so deep searches do not freeze the board.
 * If the worker fails to load, errors or stops answering, it searches on the calling thread instead.
 */
export class WorkerAiEngine implements AiEngine {
  private worker: Worker | null;
  private readonly inline = new InlineAiEngine();
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
    this.worker.onerror = () => this.breakWorker();
  }

  async choose(state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null> {
    if (!this.worker) return this.inline.choose(state, player, level);
    try {
      return await this.ask(this.worker, state, player, level);
    } catch {
      return this.inline.choose(state, player, level);
    }
  }

  dispose(): void {
    this.breakWorker();
  }

  private ask(worker: Worker, state: CoreState, player: Seat, level: AiLevel): Promise<CoreMove | null> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = globalThis.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("ai_worker_timeout"));
      }, WORKER_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (move) => { globalThis.clearTimeout(timer); resolve(move); },
        reject: (error) => { globalThis.clearTimeout(timer); reject(error); },
      });
      worker.postMessage({ id, state, player, level });
    });
  }

  private breakWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("ai_worker_failed");
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
