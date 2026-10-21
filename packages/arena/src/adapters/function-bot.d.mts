import type { BotPort } from "../ports/index.d.mts";
import type { BotStartContext, BotTurn, BotAction, WireMove } from "../contracts/index.d.mts";

export type ChooseMoveFn = (
  turn: BotTurn,
  signal: AbortSignal
) => BotAction | WireMove | Promise<BotAction | WireMove>;

export interface FunctionBotOptions {
  botId: string;
  chooseFn: ChooseMoveFn;
  onStop?: () => void | Promise<void>;
}

export interface FunctionBot extends BotPort {
  readonly botId: string;
}

export declare function createFunctionBot(options: FunctionBotOptions): FunctionBot;
