import type { Readable, Writable } from "node:stream";
import type { BotTurn, BotAction } from "../../../arena/src/contracts/index.d.mts";

export declare const MAX_STDOUT_LINE_BYTES: 65536;
export declare const MAX_STDOUT_TOTAL_BYTES: 1048576;
export declare const MAX_STDERR_TOTAL_BYTES: 262144;

export interface NdjsonChannelOptions {
  stdout: Readable;
  stderr?: Readable;
  stdin: Writable;
  clock?: { nowMs(): number };
  maxStdoutLineBytes?: number;
  maxStdoutTotalBytes?: number;
  maxStderrTotalBytes?: number;
  onStderr?: (chunk: Buffer) => void;
}

export interface NdjsonChannel {
  readonly isFaulted: boolean;
  readonly fault: { code: string; message: string } | null;
  getFault(): { code: string; message: string } | null;
  consumeFault(): { code: string; message: string } | null;
  triggerFault(errObj: { code: string; message: string }): void;
  readonly totalStdoutBytes: number;
  readonly totalStderrBytes: number;
  sendRequest(turn: BotTurn, options?: { signal?: AbortSignal }): Promise<BotAction>;
  close(): Promise<void>;
}

export declare function createNdjsonChannel(options: NdjsonChannelOptions): NdjsonChannel;
