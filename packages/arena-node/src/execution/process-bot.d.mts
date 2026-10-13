import type { BotPort, ClockPort } from "../../../arena/src/ports/index.d.mts";

export interface ProcessBotOptions {
  botId: string;
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clock?: ClockPort;
  graceMs?: number;
  maxStdoutLineBytes?: number;
  maxStdoutTotalBytes?: number;
  maxStderrTotalBytes?: number;
  onStderr?: (buf: Buffer) => void;
}

export declare function getDefaultSanitizedEnv(): Record<string, string>;

export declare function createProcessBot(
  options: ProcessBotOptions
): BotPort & {
  readonly botId: string;
  readonly pid: number | null;
  readonly hasExited: boolean;
  getReceiptTime(action: unknown): number | null;
  getFault(): { code: string; message: string } | null;
  consumeFault(): { code: string; message: string } | null;
  triggerFaultForTest?(errObj: { code: string; message: string }): void;
};
