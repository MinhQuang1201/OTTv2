/**
 * packages/arena-node/src/execution/draft-service.mjs
 *
 * Ephemeral Draft Execution Service for Arena bot workbench.
 *
 * Security & Isolation Guarantees:
 * - Fail-closed: Requires verified OCI container isolation by default. If container isolation
 *   is unavailable, fails closed (returns status: "unavailable") and NEVER silently executes
 *   untrusted code in a host process.
 * - Explicit opt-in for trusted local development/tests via options.trustedLocalMode: true,
 *   which clearly tags execution with isolation: "trusted-process" (never faking container isolation).
 * - ZERO official database pollution: zero writes to bot_versions, matches, jobs, or bot_ratings.
 * - Guaranteed cleanup of temporary directories in all failure and success paths.
 * - Enforces author bot ownership, payload UTF-8 limits (256 KiB), concurrency cap (default 2),
 *   startup timeout (5s), compile timeout (10s), turn timeout (1.5s), and output budgets (64 KiB).
 * - Reliable termination: forceful process tree teardown on startup/turn timeouts even if
 *   underlying promises ignore AbortSignals.
 * - Evaluates candidate moves with authoritative referee engine using canonical ruleset identity.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { createNodeEngine, coreConfig } from "../core/node-engine.mjs";
import { createMapState } from "../../../arena/src/domain/maps/index.mjs";
import { createCurrentRulesetSnapshot } from "../../../arena/src/contracts/index.mjs";
import { computeRulesetHash } from "../core/ruleset-identity.mjs";
import { probeContainerRuntime, createContainerBot, createContainerBuildService } from "./container-executor.mjs";
import { createArtifactStore } from "../artifacts/artifact-store.mjs";

const DEFAULT_COMPILE_TIMEOUT_MS = 10000;
const DEFAULT_START_TIMEOUT_MS = 5000;
const DEFAULT_TURN_TIMEOUT_MS = 1500;
const DEFAULT_MAX_OUTPUT_BYTES = 65536; // 64 KiB
const MAX_SOURCE_BYTES = 262144; // 256 KiB
const DEFAULT_MAX_CONCURRENT_DRAFTS = 2;

export class OwnershipMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "OwnershipMismatchError";
    this.code = "OWNERSHIP_MISMATCH";
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(message = "Draft execution concurrency limit reached. Please retry in a moment.") {
    super(message);
    this.name = "ConcurrencyLimitError";
    this.code = "CONCURRENCY_LIMIT_EXCEEDED";
    this.statusCode = 429;
  }
}

/**
 * Creates an Ephemeral Draft Execution Service.
 *
 * @param {object} options
 * @param {import('./profile-registry.d.mts').ProfileRegistry} options.profileRegistry
 * @param {object} [options.containerExecutor]
 * @param {boolean} [options.trustedLocalMode=false] - Explicit opt-in for trusted host process execution.
 * @param {string} [options.tempBaseDir]
 * @param {number} [options.maxConcurrentDrafts=2]
 * @param {number} [options.compileTimeoutMs=10000]
 * @param {number} [options.startTimeoutMs=5000]
 * @param {number} [options.turnTimeoutMs=1500]
 * @param {number} [options.maxOutputBytes=65536]
 * @returns {import('./draft-service.d.mts').DraftService}
 */
export function createDraftService(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("createDraftService requires options");
  }

  const {
    profileRegistry,
    containerExecutor = null,
    trustedLocalMode = false,
    tempBaseDir = os.tmpdir(),
    maxConcurrentDrafts = DEFAULT_MAX_CONCURRENT_DRAFTS,
    compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
  } = options;

  if (!profileRegistry) {
    throw new TypeError("options.profileRegistry is required");
  }

  const engine = createNodeEngine();
  let activeConcurrentDrafts = 0;

  return {
    trustedLocalMode: Boolean(trustedLocalMode),

    async runDraft({
      db,
      authorId,
      authorRole = "author",
      isAdmin = false,
      botId,
      source,
      profileId,
      mapId = "classic"
    }) {
      if (!db) throw new TypeError("db is required");
      if (!authorId) throw new TypeError("authorId is required");
      if (!botId) throw new TypeError("botId is required");
      if (typeof source !== "string") throw new TypeError("source must be a string");
      if (!profileId) throw new TypeError("profileId is required");

      // 1. Enforce per-instance draft concurrency cap
      if (activeConcurrentDrafts >= maxConcurrentDrafts) {
        throw new ConcurrencyLimitError();
      }
      activeConcurrentDrafts++;

      try {
        // 2. Author ownership verification (owner or admin)
        const bot = db.prepare("SELECT id, owner_id FROM bots WHERE id = ?").get(botId);
        if (!bot) {
          const err = new Error(`Bot not found: ${botId}`);
          err.code = "NOT_FOUND";
          throw err;
        }

        const isOwnerOrAdmin = bot.owner_id === authorId || authorRole === "admin" || isAdmin === true;
        if (!isOwnerOrAdmin) {
          const err = new OwnershipMismatchError(
            `Bot '${botId}' belongs to '${bot.owner_id}', not '${authorId}'`
          );
          throw err;
        }

        // 3. Source payload size guard
        const sourceBytes = Buffer.byteLength(source, "utf8");
        if (sourceBytes > MAX_SOURCE_BYTES) {
          return {
            status: "compile_error",
            isolation: trustedLocalMode ? "trusted-process" : "container",
            compile: {
              status: "failed",
              logs: `Source code exceeds maximum allowed size of ${MAX_SOURCE_BYTES} bytes (received ${sourceBytes} bytes)`
            }
          };
        }

        // 4. Resolve execution profile
        const profile = profileRegistry.getProfile(profileId);
        if (!profile) {
          return {
            status: "compile_error",
            isolation: trustedLocalMode ? "trusted-process" : "container",
            compile: {
              status: "failed",
              logs: `Unsupported execution profile: '${profileId}'`
            }
          };
        }

        // 5. Fail-closed Isolation Capability Gate
        let isolationMode;
        if (trustedLocalMode) {
          isolationMode = "trusted-process";
        } else {
          const probe = containerExecutor?.probe
            ? containerExecutor.probe()
            : probeContainerRuntime({
                commandRunner: containerExecutor?.commandRunner,
                image: containerExecutor?.image,
                expectedImageId: containerExecutor?.expectedImageId
              });

          if (!probe.available) {
            return {
              status: "unavailable",
              isolation: "container",
              error: "Container isolation runtime is unavailable; draft execution requires a verified OCI container environment.",
              details: {
                reason: probe.reason || "docker_daemon_unavailable"
              }
            };
          }
          isolationMode = "container";
        }

        // 6. Create isolated temporary workspace
        const tempDir = fs.mkdtempSync(path.join(tempBaseDir, "arena-draft-"));

        try {
          let artifactPath = null;
          let tempArtifactStore = null;
          let artifactDigest = null;
          let compileLogs = "";
          const profileLang = profile.language === "javascript" ? "node" : (profile.id || profile.language);

          if (isolationMode === "container") {
            if (profileLang !== "python" && profileLang !== "node") {
              return {
                status: "compile_error",
                isolation: isolationMode,
                compile: {
                  status: "failed",
                  logs: `Profile '${profileId}' is not supported under container isolation. Scoped profiles: 'python', 'node'.`
                }
              };
            }

            // 7a. Container isolation: build and verify syntax INSIDE isolated container via buildService
            tempArtifactStore = createArtifactStore({ storageDir: path.join(tempDir, "artifacts") });
            const containerBuildService = createContainerBuildService({
              artifactStore: tempArtifactStore,
              image: containerExecutor?.image,
              commandRunner: containerExecutor?.commandRunner || null,
              limits: containerExecutor?.buildLimits
            });

            const buildRes = await containerBuildService.build({
              sourceContent: source,
              profileId: profileLang
            });

            if (buildRes.status !== "READY") {
              const rawLogs = (buildRes.logs || buildRes.error || "Compilation failed in container").trim();
              const logs = rawLogs.length > maxOutputBytes ? rawLogs.slice(0, maxOutputBytes) + " [truncated]" : rawLogs;
              return {
                status: "compile_error",
                isolation: isolationMode,
                compile: {
                  status: "failed",
                  logs
                }
              };
            }

            compileLogs = (buildRes.logs || "").trim();
            artifactDigest = buildRes.artifactDigest;
          } else {
            // 7b. Trusted-process mode: compile/syntax check on host in isolated tempDir
            const entryName = profile.entryName || (profile.language === "python" ? "bot.py" : "bot.mjs");
            const sourceFilePath = path.join(tempDir, entryName);
            fs.writeFileSync(sourceFilePath, source, "utf8");

            const compileRes = profile.compile({
              buildDir: tempDir,
              sourceFilePath,
              timeoutMs: compileTimeoutMs
            });

            if (compileRes.status !== 0) {
              const rawLogs = (compileRes.stderr || compileRes.stdout || "Compilation failed").trim();
              const logs = rawLogs.length > maxOutputBytes ? rawLogs.slice(0, maxOutputBytes) + " [truncated]" : rawLogs;
              return {
                status: "compile_error",
                isolation: isolationMode,
                compile: {
                  status: "failed",
                  logs
                }
              };
            }

            compileLogs = (compileRes.stdout || "").trim();
            artifactPath = compileRes.entrypoint
              ? path.join(tempDir, compileRes.entrypoint)
              : sourceFilePath;
          }

          // 8. Create referee initial state for requested map
          let initialState;
          try {
            initialState = createMapState(mapId || "classic");
          } catch (mapErr) {
            return {
              status: "execution_error",
              isolation: isolationMode,
              execution: {
                error: `Invalid map '${mapId}': ${mapErr.message}`
              }
            };
          }

          // Authoritative referee identity (never invented 'draft' strings)
          const rulesetSnapshot = createCurrentRulesetSnapshot(coreConfig);
          const rulesetHash = computeRulesetHash(rulesetSnapshot);
          const draftMatchId = `draft-${botId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // 9. Instantiate candidate bot (real container or trusted process)
          let botInstance = null;
          try {
            if (isolationMode === "container") {
              botInstance = createContainerBot({
                botId: `draft-${botId}`,
                profileId: profileLang,
                artifactStore: tempArtifactStore,
                artifactDigest,
                commandRunner: containerExecutor?.commandRunner || null,
                limits: containerExecutor?.limits,
                image: containerExecutor?.image
              });
            } else {
              botInstance = profile.createBot(artifactPath, {
                botId: `draft-${botId}`,
                cwd: tempDir,
                maxStdoutTotalBytes: maxOutputBytes,
                maxStderrTotalBytes: maxOutputBytes
              });
            }

            // 10. Startup handshake with strict timeout and forced termination on abort/hang
            let startTimer = null;
            const startTimeoutPromise = new Promise((_, reject) => {
              startTimer = setTimeout(() => {
                const err = new Error(`Bot startup timed out after ${startTimeoutMs}ms`);
                err.code = "start_timeout";
                reject(err);
              }, startTimeoutMs);
            });

            try {
              await Promise.race([
                botInstance.start({
                  matchId: draftMatchId,
                  seat: "A",
                  rulesetId: mapId || "classic",
                  rulesetHash,
                  initialTimeMs: 10000,
                  turnTimeLimitMs: turnTimeoutMs
                }),
                startTimeoutPromise
              ]);
            } catch (startErr) {
              try {
                await botInstance.stop();
              } catch (_) {}
              const isTimeout =
                startErr.code === "start_timeout" ||
                (startErr.message && startErr.message.toLowerCase().includes("timed out"));
              return {
                status: "execution_error",
                isolation: isolationMode,
                execution: {
                  error: isTimeout ? "start_timeout" : (startErr.message || "start_failed")
                }
              };
            } finally {
              if (startTimer) clearTimeout(startTimer);
            }

            // 11. Execute opening turn with strict timeout and forced termination
            let turnTimer = null;
            const turnTimeoutPromise = new Promise((_, reject) => {
              turnTimer = setTimeout(() => {
                const err = new Error(`Bot turn timed out after ${turnTimeoutMs}ms`);
                err.code = "turn_timeout";
                reject(err);
              }, turnTimeoutMs);
            });

            const turnAbort = new AbortController();
            const startWall = performance.now();
            let action;

            try {
              action = await Promise.race([
                botInstance.requestMove(
                  {
                    type: "turn",
                    matchId: draftMatchId,
                    requestId: "draft-req-1",
                    seat: "A",
                    ply: 1,
                    state: initialState,
                    deadlineMs: turnTimeoutMs,
                    turnTimeLimitMs: turnTimeoutMs
                  },
                  turnAbort.signal
                ),
                turnTimeoutPromise
              ]);
            } catch (turnErr) {
              try {
                await botInstance.stop();
              } catch (_) {}
              const isTimeout =
                turnAbort.signal.aborted ||
                turnErr.code === "turn_timeout" ||
                turnErr.name === "AbortError" ||
                (turnErr.message && turnErr.message.toLowerCase().includes("timeout"));
              return {
                status: "execution_error",
                isolation: isolationMode,
                execution: {
                  error: isTimeout ? "turn_timeout" : (turnErr.message || "bot_crashed")
                }
              };
            } finally {
              if (turnTimer) clearTimeout(turnTimer);
            }

            const elapsedMs = Math.round(performance.now() - startWall);

            // 12. Strict move coordinate structural validation
            if (
              !action ||
              typeof action !== "object" ||
              !action.move ||
              typeof action.move !== "object" ||
              !action.move.from ||
              !action.move.to ||
              typeof action.move.from.x !== "number" ||
              typeof action.move.from.y !== "number" ||
              typeof action.move.to.x !== "number" ||
              typeof action.move.to.y !== "number"
            ) {
              return {
                status: "execution_error",
                isolation: isolationMode,
                execution: {
                  error: "protocol_error: bot response did not include valid move coordinates"
                }
              };
            }

            // 13. Authoritative referee legality assessment
            const moveRes = engine.applyMove(initialState, "A", action.move.from, action.move.to);
            if (!moveRes.ok) {
              return {
                status: "execution_error",
                isolation: isolationMode,
                execution: {
                  legal: false,
                  move: action.move,
                  comment: action.comment || null,
                  elapsedMs,
                  error: `illegal_move: ${moveRes.error}`
                }
              };
            }

            return {
              status: "success",
              isolation: isolationMode,
              compile: {
                status: "ok",
                logs: compileLogs.length > maxOutputBytes ? compileLogs.slice(0, maxOutputBytes) + " [truncated]" : compileLogs
              },
              execution: {
                legal: true,
                move: action.move,
                comment: action.comment || null,
                elapsedMs
              },
              nextState: moveRes.state
            };
          } catch (botErr) {
            const isTimeout = botErr.message && botErr.message.toLowerCase().includes("timeout");
            return {
              status: "execution_error",
              isolation: isolationMode,
              execution: {
                error: isTimeout ? "turn_timeout" : (botErr.code || botErr.message || "bot_execution_failed")
              }
            };
          } finally {
            if (botInstance) {
              try {
                await botInstance.stop();
              } catch (_) {}
            }
          }
        } finally {
          // Guaranteed cleanup of temporary workspace directory in all paths
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (_) {}
        }
      } finally {
        activeConcurrentDrafts--;
      }
    }
  };
}
