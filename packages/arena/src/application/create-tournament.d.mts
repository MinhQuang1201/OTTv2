export interface TournamentEntryInput {
  botId: string;
  botVersionId: string;
}

export interface CreateTournamentInput {
  id?: string;
  name: string;
  ruleset?: unknown;
  rulesetJson?: string;
  policy?: unknown;
  policyJson?: string;
  profile?: unknown;
  profileJson?: string;
  initialState?: unknown;
  initialStateJson?: string;
  ranked?: boolean | number;
  ladderId?: string;
  pointScheme?: "3-1-0";
  entries: readonly TournamentEntryInput[];
}

export interface CreateTournamentOptions {
  actorId?: string;
  idempotencyKey?: string;
}

export interface CreateTournamentUseCase {
  execute(input: CreateTournamentInput, options?: CreateTournamentOptions): Promise<unknown>;
}

export function createTournamentUseCase(dependencies: {
  tournamentRepo: unknown;
  scheduleGenerator?: (entries: readonly unknown[]) => unknown[];
}): CreateTournamentUseCase;
