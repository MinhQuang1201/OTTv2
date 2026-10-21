/**
 * Incremental NDJSON stream channel with byte budgets and strict protocol framing.
 * Enforces per-line stdout cap, total stdout cap, bounded stderr, and UTF-8 fatal validation.
 */

import { Buffer } from "node:buffer";

export const MAX_STDOUT_LINE_BYTES = 65536;    // 64 KiB
export const MAX_STDOUT_TOTAL_BYTES = 1048576;  // 1 MiB
export const MAX_STDERR_TOTAL_BYTES = 262144;   // 256 KiB

/**
 * Creates an NDJSON channel over process standard streams.
 * @param {object} options
 * @param {import("node:stream").Readable} options.stdout
 * @param {import("node:stream").Readable} [options.stderr]
 * @param {import("node:stream").Writable} options.stdin
 * @param {object} [options.clock]
 * @param {number} [options.maxStdoutLineBytes=65536]
 * @param {number} [options.maxStdoutTotalBytes=1048576]
 * @param {number} [options.maxStderrTotalBytes=262144]
 * @param {function} [options.onStderr]
 */
export function createNdjsonChannel(options) {
  if (!options || typeof options !== "object") {
    throw new Error("createNdjsonChannel requires an options object");
  }

  const {
    stdout,
    stderr,
    stdin,
    clock = { nowMs: () => performance.now() },
    maxStdoutLineBytes = MAX_STDOUT_LINE_BYTES,
    maxStdoutTotalBytes = MAX_STDOUT_TOTAL_BYTES,
    maxStderrTotalBytes = MAX_STDERR_TOTAL_BYTES,
    onStderr
  } = options;

  if (!stdout || typeof stdout.on !== "function") {
    throw new Error("stdout must be a readable stream");
  }
  if (!stdin || typeof stdin.write !== "function") {
    throw new Error("stdin must be a writable stream");
  }

  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  let currentLineChunks = [];
  let currentLineByteCount = 0;

  let pendingRequest = null;
  let fault = null; // { code, message }
  let closed = false;

  const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

  function triggerFault(errObj) {
    if (!fault) {
      fault = errObj;
    }
    const err = new Error(errObj.message);
    err.code = errObj.code;

    if (pendingRequest) {
      const req = pendingRequest;
      pendingRequest = null;
      req.reject(err);
    }
  }

  function handleStdoutChunk(chunk) {
    if (closed || fault) return;

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    // 1. Total stdout byte budget BEFORE decoding or line buffering
    totalStdoutBytes += buf.length;
    if (totalStdoutBytes > maxStdoutTotalBytes) {
      triggerFault({
        code: "output_limit",
        message: `Total stdout budget (${maxStdoutTotalBytes} bytes) exceeded: received ${totalStdoutBytes} bytes`
      });
      return;
    }

    // 2. Scan chunk for newlines (0x0A)
    // Gather all completed lines found in this chunk batch
    let startIdx = 0;
    const completedLines = [];

    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) { // '\n'
        const slice = buf.subarray(startIdx, i);
        const lineBytes = currentLineByteCount + slice.length;

        // Byte budget check for this line BEFORE decode
        if (lineBytes > maxStdoutLineBytes) {
          triggerFault({
            code: "output_limit",
            message: `Stdout line exceeded cap (${maxStdoutLineBytes} bytes): received ${lineBytes} bytes`
          });
          return;
        }

        // Assemble full line buffer
        let lineBuf;
        if (currentLineChunks.length === 0) {
          lineBuf = slice;
        } else {
          currentLineChunks.push(slice);
          lineBuf = Buffer.concat(currentLineChunks);
        }

        // Reset accumulator
        currentLineChunks = [];
        currentLineByteCount = 0;

        // Strip trailing \r (CRLF) if present
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }

        const receivedAtMs = clock.nowMs ? clock.nowMs() : performance.now();
        completedLines.push({ buffer: lineBuf, receivedAtMs });
        startIdx = i + 1;
      }
    }

    // Accumulate remaining tail bytes without newline
    if (startIdx < buf.length) {
      const tail = buf.subarray(startIdx);
      currentLineByteCount += tail.length;
      if (currentLineByteCount > maxStdoutLineBytes) {
        triggerFault({
          code: "output_limit",
          message: `Stdout line exceeded cap (${maxStdoutLineBytes} bytes): received ${currentLineByteCount} bytes`
        });
        return;
      }
      currentLineChunks.push(tail);
    }

    if (completedLines.length === 0) return;

    // Check for duplicate lines in the same chunk:
    // If multiple lines arrived for a single pending request:
    // "duplicate2linesSAMEchunkmustfaultbeforeresolve"
    if (completedLines.length > 1 && pendingRequest) {
      triggerFault({
        code: "protocol_error",
        message: `Multiple response lines (${completedLines.length}) received in the same chunk for a single request`
      });
      return;
    }

    // Process completed lines
    for (const lineItem of completedLines) {
      if (fault) return;

      // 3. Fatal UTF-8 decoding
      let text;
      try {
        text = fatalUtf8Decoder.decode(lineItem.buffer);
      } catch (decodeErr) {
        triggerFault({
          code: "protocol_error",
          message: `Invalid UTF-8 sequence in stdout line: ${decodeErr.message}`
        });
        return;
      }

      // 4. Unsolicited output check
      if (!pendingRequest) {
        triggerFault({
          code: "protocol_error",
          message: `Unsolicited output received on stdout when no turn request was pending: "${text.slice(0, 100)}"`
        });
        return;
      }

      // 5. Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (jsonErr) {
        triggerFault({
          code: "protocol_error",
          message: `Malformed JSON on stdout: ${jsonErr.message}`
        });
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        triggerFault({
          code: "protocol_error",
          message: "Bot response must be a JSON object"
        });
        return;
      }

      // 6. Check requestId identity
      if (parsed.requestId !== pendingRequest.id) {
        triggerFault({
          code: "protocol_error",
          message: `Stale or mismatched requestId: expected '${pendingRequest.id}', got '${parsed.requestId}'`
        });
        return;
      }

      // 7. Check protocol version
      if (parsed.protocolVersion !== 1) {
        triggerFault({
          code: "protocol_error",
          message: `Invalid protocolVersion: expected 1, got ${parsed.protocolVersion}`
        });
        return;
      }

      // Attach authoritative referee clock timestamp captured at complete line
      parsed.receivedAtMs = lineItem.receivedAtMs;

      // Fulfill pending request
      const req = pendingRequest;
      pendingRequest = null;
      req.resolve(parsed);
    }
  }

  function handleStderrChunk(chunk) {
    if (closed || fault) return;

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalStderrBytes += buf.length;

    if (totalStderrBytes > maxStderrTotalBytes) {
      triggerFault({
        code: "output_limit",
        message: `Total stderr budget (${maxStderrTotalBytes} bytes) exceeded: received ${totalStderrBytes} bytes`
      });
      return;
    }

    if (typeof onStderr === "function") {
      try {
        onStderr(buf);
      } catch (_) {}
    }
  }

  function handleStdoutEnd() {
    if (closed) return;

    if (currentLineByteCount > 0) {
      triggerFault({
        code: "protocol_error",
        message: "Stdout stream closed with incomplete line (missing terminating newline before EOF)"
      });
      return;
    }

    if (pendingRequest) {
      triggerFault({
        code: "crash",
        message: "Stdout closed while a turn request was pending"
      });
    }
  }

  function handleStdoutError(err) {
    triggerFault({
      code: "crash",
      message: `Stdout stream error: ${err?.message || err}`
    });
  }

  function handleStdinError(err) {
    triggerFault({
      code: "crash",
      message: `Stdin stream error: ${err?.message || err}`
    });
  }

  // Attach event listeners
  stdout.on("data", handleStdoutChunk);
  stdout.on("end", handleStdoutEnd);
  stdout.on("error", handleStdoutError);

  if (stdin && typeof stdin.on === "function") {
    stdin.on("error", handleStdinError);
  }

  if (stderr && typeof stderr.on === "function") {
    stderr.on("data", handleStderrChunk);
  }

  return {
    get isFaulted() {
      return fault !== null;
    },

    get fault() {
      return fault;
    },

    getFault() {
      return fault;
    },

    consumeFault() {
      return fault;
    },

    triggerFault(errObj) {
      triggerFault(errObj);
    },

    get totalStdoutBytes() {
      return totalStdoutBytes;
    },

    get totalStderrBytes() {
      return totalStderrBytes;
    },

    sendRequest(turn, options = {}) {
      if (closed) {
        const err = new Error("NDJSON channel is closed");
        err.code = "crash";
        return Promise.reject(err);
      }

      if (fault) {
        const err = new Error(fault.message);
        err.code = fault.code;
        return Promise.reject(err);
      }

      if (pendingRequest) {
        const err = new Error(`Concurrent requests not allowed: request ${pendingRequest.id} is already pending`);
        err.code = "concurrent_request";
        return Promise.reject(err);
      }

      if (!turn || typeof turn !== "object" || !turn.requestId) {
        const err = new Error("Invalid turn payload: missing requestId");
        err.code = "protocol_error";
        return Promise.reject(err);
      }

      return new Promise((resolve, reject) => {
        let onAbort = null;
        const signal = options.signal;

        function cleanupSignal() {
          if (signal && onAbort) {
            signal.removeEventListener("abort", onAbort);
            onAbort = null;
          }
        }

        const req = {
          id: turn.requestId,
          resolve: (val) => {
            cleanupSignal();
            resolve(val);
          },
          reject: (err) => {
            cleanupSignal();
            reject(err);
          },
          turn
        };

        if (signal) {
          if (signal.aborted) {
            const abortErr = new Error(`Request ${turn.requestId} aborted`);
            abortErr.name = "AbortError";
            reject(abortErr);
            return;
          }

          onAbort = () => {
            if (pendingRequest === req) {
              pendingRequest = null;
              const abortErr = new Error(`Request ${turn.requestId} aborted`);
              abortErr.name = "AbortError";
              reject(abortErr);
            }
          };
          signal.addEventListener("abort", onAbort);
        }

        pendingRequest = req;

        // Write turn payload to stdin
        try {
          const serialized = JSON.stringify(turn) + "\n";
          stdin.write(serialized, "utf8", (writeErr) => {
            if (writeErr && pendingRequest === req) {
              pendingRequest = null;
              cleanupSignal();
              const err = new Error(`Failed to write turn to bot stdin: ${writeErr.message}`);
              err.code = "crash";
              reject(err);
            }
          });
        } catch (serErr) {
          pendingRequest = null;
          cleanupSignal();
          const err = new Error(`Serialization error: ${serErr.message}`);
          err.code = "crash";
          reject(err);
        }
      });
    },

    async close() {
      if (closed) return;
      closed = true;

      // Detach listeners
      stdout.removeListener("data", handleStdoutChunk);
      stdout.removeListener("end", handleStdoutEnd);
      stdout.removeListener("error", handleStdoutError);

      if (stdin && typeof stdin.removeListener === "function") {
        stdin.removeListener("error", handleStdinError);
      }

      if (stderr && typeof stderr.removeListener === "function") {
        stderr.removeListener("data", handleStderrChunk);
      }

      if (pendingRequest) {
        const req = pendingRequest;
        pendingRequest = null;
        const err = new Error("NDJSON channel closed");
        err.code = "crash";
        req.reject(err);
      }

      currentLineChunks = [];
      currentLineByteCount = 0;
    }
  };
}
