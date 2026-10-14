export type CompetitionPhase = "registration" | "preparation" | "locked" | "running" | "completed";

export type CompetitionEntryStatus = "pending" | "accepted" | "declined";

export interface Competition {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly phase: CompetitionPhase;
  readonly capacity?: number | null;
  readonly ranked?: boolean;
  readonly tournamentId?: string | null;
  readonly createdAt: string;
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
}

export interface CompetitionListResponse {
  readonly competitions: readonly Competition[];
}

export interface CreateCompetitionRequest {
  readonly name: string;
  readonly description?: string;
  readonly capacity?: number;
  readonly ranked?: boolean;
}

export interface ReadyBotVersionOption {
  readonly versionId: string;
  readonly botId: string;
  readonly botName: string;
  readonly versionNo: number;
  readonly profileId: string;
}
