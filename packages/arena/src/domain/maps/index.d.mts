export interface CorePiece {
  id: string;
  player: "A" | "B";
  type: "dam" | "la" | "keo";
  x: number;
  y: number;
}

export interface CoreClock {
  remainingMs: {
    A: number;
    B: number;
  };
  runningSeat: "A" | "B" | null;
}

export interface CoreState {
  turn: "A" | "B" | null;
  winner: "A" | "B" | null;
  reason: string | null;
  eliminatedPlayer: "A" | "B" | null;
  clock: CoreClock;
  pieces: CorePiece[];
}

export interface MapDescriptor {
  id: string;
  revision: number;
  name: string;
  description: string;
  initialState?: CoreState;
}

export interface MapOptions {
  includeState?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PieceSetup {
  type: "dam" | "la" | "keo";
  x: number;
  y: number;
}

export interface MapDefinition {
  id: string;
  revision: number;
  name: string;
  description: string;
  setupA: readonly PieceSetup[];
}

export const BOARD_SIZE: 9;
export const GOALS: {
  readonly A: { readonly x: 0; readonly y: 0 };
  readonly B: { readonly x: 8; readonly y: 8 };
};
export const EXPECTED_TYPE_COUNTS: {
  readonly dam: 3;
  readonly la: 4;
  readonly keo: 3;
};
export const MOVEMENT_DELTAS: readonly (readonly [number, number])[];
export const BEATS: {
  readonly dam: "keo";
  readonly keo: "la";
  readonly la: "dam";
};

export const CLASSIC_SETUP_A: readonly PieceSetup[];
export const FLANKS_SETUP_A: readonly PieceSetup[];
export const CENTER_SETUP_A: readonly PieceSetup[];
export const MAP_DEFINITIONS: Record<string, MapDefinition>;

export function computePureLegalMoves(
  pieces: CorePiece[],
  seat: "A" | "B"
): Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;

export function validateMapSetup(setupA: unknown): ValidationResult;
export function validateMapState(state: unknown): ValidationResult;

export function listMaps(options?: MapOptions): MapDescriptor[];
export function getMap(id: string, options?: MapOptions): MapDescriptor | null;
export function createMapState(id?: string, revision?: number): CoreState;
