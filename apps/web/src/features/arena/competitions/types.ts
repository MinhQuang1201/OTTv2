export type CompetitionPhase = "registration" | "preparation" | "locked" | "running" | "completed";

export type CompetitionEntryStatus = "pending" | "accepted" | "declined";

export type CompetitionMode = "ranked" | "practice";

export interface MapInitialPiece {
  readonly id?: string;
  readonly player?: "A" | "B";
  readonly seat?: "A" | "B";
  readonly type: "dam" | "la" | "keo";
  readonly x: number;
  readonly y: number;
}

export interface MapInitialState {
  readonly turn?: "A" | "B";
  readonly pieces: readonly MapInitialPiece[];
}

export interface MapDescriptor {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly initialState?: MapInitialState;
}

export interface FormatDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ModeDescriptor {
  readonly id: CompetitionMode;
  readonly name: string;
}

export interface CatalogDefaults {
  readonly mapId: string;
  readonly formatId: string;
  readonly mode: CompetitionMode;
}

export interface CompetitionCatalogResponse {
  readonly maps: readonly MapDescriptor[];
  readonly formats: readonly FormatDescriptor[];
  readonly modes: readonly ModeDescriptor[];
  readonly defaults: CatalogDefaults;
}

export interface CompetitionConfig {
  readonly formatId: string;
  readonly mapId: string;
  readonly mapRevision?: number;
  readonly mode: CompetitionMode;
  readonly roundCount?: number;
  readonly currentRound?: number;
}

export type CompetitionConfigurationData = CompetitionConfig;

export interface CompetitionRoundPairing {
  readonly scheduleIndex: number;
  readonly botAId: string;
  readonly botBId: string;
}

export interface CompetitionRoundItem {
  readonly roundNumber: number;
  readonly tournamentId: string;
  readonly status: string;
  readonly byes?: readonly string[];
  readonly pairings?: readonly CompetitionRoundPairing[];
  readonly warnings?: readonly string[];
}

export interface CompetitionAggregateStanding {
  readonly botId: string;
  readonly botName?: string;
  readonly points: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly byes?: number;
  readonly rank?: number;
}

export interface Competition {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly phase: CompetitionPhase;
  readonly capacity?: number | null;
  readonly ranked?: boolean;
  readonly tournamentId?: string | null;
  readonly createdAt: string;
  readonly configuration?: CompetitionConfig | null;
}

export interface CompetitionEntry {
  readonly userId: string;
  readonly username: string;
  readonly status: CompetitionEntryStatus;
  readonly botId: string | null;
  readonly botName: string | null;
  readonly botVersionId: string | null;
  readonly versionNo: number | null;
  readonly buildStatus: string | null;
}

export interface CompetitionDetailResponse {
  readonly competition: Competition;
  readonly entries: readonly CompetitionEntry[];
  readonly configuration?: CompetitionConfig | null;
  readonly rounds?: readonly CompetitionRoundItem[];
  readonly standings?: readonly CompetitionAggregateStanding[];
}

export interface CompetitionListResponse {
  readonly competitions: readonly Competition[];
}

export interface CreateCompetitionRequest {
  readonly name: string;
  readonly description?: string;
  readonly capacity?: number;
  readonly ranked?: boolean;
  readonly formatId?: string;
  readonly mapId?: string;
  readonly roundCount?: number;
  readonly mode?: CompetitionMode;
}

export interface ReadyBotVersionOption {
  readonly versionId: string;
  readonly botId: string;
  readonly botName: string;
  readonly versionNo: number;
  readonly profileId: string;
}

export interface RetryMatchResponse {
  readonly ok: boolean;
}

export interface NextRoundResponse {
  readonly competition: Competition;
}
