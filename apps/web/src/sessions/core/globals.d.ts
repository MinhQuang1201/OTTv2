declare global {
  interface OttCoreConfig {
    readonly SIZE: number;
    readonly GOAL: Readonly<Record<"A" | "B", { readonly x: number; readonly y: number }>>;
    readonly TIME_CONTROL: Readonly<{ readonly initialMs: number; readonly reconnectGraceMs: number }>;
  }

  interface OttCorePiece {
    readonly id: string;
    readonly player: "A" | "B";
    readonly type: "dam" | "la" | "keo";
    readonly x: number;
    readonly y: number;
  }

  interface OttCoreState {
    readonly turn: "A" | "B" | null;
    readonly winner: "A" | "B" | null;
    readonly reason: string | null;
    readonly eliminatedPlayer: "A" | "B" | null;
    readonly clock: {
      readonly remainingMs: { readonly A: number; readonly B: number };
      readonly runningSeat: "A" | "B" | null;
    };
    readonly pieces: readonly OttCorePiece[];
  }

  interface OttCoreEvent {
    readonly type: string;
    readonly pieceId?: string;
    readonly capturedId?: string;
    readonly byId?: string;
    readonly from?: { readonly x: number; readonly y: number };
    readonly to?: { readonly x: number; readonly y: number };
    readonly winner?: "A" | "B";
    readonly reason?: string;
  }

  interface OttCoreMoveResult {
    readonly ok: boolean;
    readonly error: string | null;
    readonly state: OttCoreState | null;
    readonly events: readonly OttCoreEvent[];
  }

  interface OttCoreRules {
    createInitialState(): OttCoreState;
    getLegalMoves(state: OttCoreState, pieceId: string): readonly { readonly x: number; readonly y: number }[];
    applyMove(state: OttCoreState, player: "A" | "B", from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): OttCoreMoveResult;
    elapseClock(state: OttCoreState, elapsedMs: number): OttCoreMoveResult;
    countByType(state: OttCoreState, player: "A" | "B"): Readonly<Record<"dam" | "la" | "keo", number>>;
  }

  interface OttCoreAi {
    chooseMove(state: OttCoreState, player: "A" | "B"): { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number } } | null;
  }

  var OTT_CONFIG: OttCoreConfig | undefined;
  var OTT_RULES: OttCoreRules | undefined;
  var OTT_AI: OttCoreAi | undefined;
}

export {};
