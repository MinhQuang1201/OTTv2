/**
 * Arena CLI — Task 4 (Milestone M1)
 * Provides offline arena capabilities:
 * - doctor: diagnostic check of runtime, ruleset identity, and execution capabilities
 * - match: executes headless match with FunctionBot, writes validated replay atomically
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RULESET_ID_G_V1,
  DEFAULT_MATCH_POLICY,
  createCurrentRulesetSnapshot,
  validateReplayDocument
} from "../../../packages/arena/src/contracts/index.mjs";

import { createHeadlessMatchController } from "../../../packages/arena/src/application/match-controller.mjs";
import { createReplayJournal } from "../../../packages/arena/src/application/replay-journal.mjs";
import { createFunctionBot } from "../../../packages/arena/src/adapters/function-bot.mjs";
import { createNodeEngine, coreConfig } from "../../../packages/arena-node/src/core/node-engine.mjs";
import {
  computeRulesetHash,
  computeCurrentEngineFingerprint,
  computeReplayDigest
} from "../../../packages/arena-node/src/core/ruleset-identity.mjs";
import { createNodeClock } from "../../../packages/arena-node/src/clock/node-clock.mjs";
import { createProfileRegistry } from "../../../packages/arena-node/src/execution/profile-registry.mjs";

function parseMatchOptions(args) {
  const options = {
    botA: "first-legal",
    botB: "first-legal",
    kind: "practice",
    output: null,
    overwrite: false
  };
  const seenFlags = new Set();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--overwrite") {
      if (seenFlags.has("--overwrite")) {
        return { error: 'Duplicate flag "--overwrite".' };
      }
      seenFlags.add("--overwrite");
      options.overwrite = true;
      continue;
    }

    if (arg === "--bot-a" || arg === "--bot-b" || arg === "--kind" || arg === "--output") {
      if (seenFlags.has(arg)) {
        return { error: `Duplicate flag "${arg}".` };
      }
      seenFlags.add(arg);
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return { error: `Missing value for flag "${arg}".` };
      }
      const val = args[++i];
      if (arg === "--bot-a") options.botA = val;
      else if (arg === "--bot-b") options.botB = val;
      else if (arg === "--kind") options.kind = val;
      else if (arg === "--output") options.output = val;
      continue;
    }

    if (arg.startsWith("-")) {
      return { error: `Unknown flag "${arg}".` };
    }

    return { error: `Unexpected positional argument "${arg}".` };
  }

  return { options };
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || ((msg) => console.log(msg));
  const stderr = io.stderr || ((msg) => console.error(msg));
  const cwd = io.cwd || process.cwd();

  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    stderr(
      "Usage:\n" +
      "  arena-cli doctor\n" +
      "  arena-cli match --bot-a <first-legal> --bot-b <first-legal> --kind <practice> --output <path> [--overwrite]"
    );
    return 2;
  }

  if (command === "doctor") {
    if (argv.length > 1) {
      stderr(`Error: doctor command does not accept positional arguments.`);
      return 2;
    }
    return await handleDoctor(stdout, stderr, io);
  }

  if (command === "match") {
    return handleMatch(argv.slice(1), stdout, stderr, cwd, io);
  }

  stderr(`Error: Unknown command "${command}". Run with --help for usage.`);
  return 2;
}

async function handleDoctor(stdout, stderr, io = {}) {
  try {
    const getEngineFingerprint = io.getEngineFingerprint || computeCurrentEngineFingerprint;
    const rulesetSnapshot = io.getRulesetSnapshot
      ? io.getRulesetSnapshot()
      : createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = io.getRulesetHash
      ? io.getRulesetHash(rulesetSnapshot)
      : computeRulesetHash(rulesetSnapshot);
    const engineFingerprint = getEngineFingerprint();
    const registry = io.getRegistry ? io.getRegistry() : createProfileRegistry();

    stdout("[Arena Doctor]");
    stdout(`Runtime: Node ${process.version} (${process.platform} ${process.arch})`);
    stdout(`Ruleset: ${RULESET_ID_G_V1}`);
    stdout(`  Ruleset Hash: ${rulesetHash}`);
    stdout(`  Engine Fingerprint: ${engineFingerprint}`);
    stdout("Capabilities:");
    stdout("  FunctionBot: in-process only");
    stdout("  process runner: not implemented in standalone CLI match (trusted-local process runner implemented in runner)");
    const pythonProbe = registry.probeProfile ? registry.probeProfile("python") : { available: false };
    const nodeProbe = registry.probeProfile ? registry.probeProfile("node") : { available: false };
    stdout(`  trusted profiles: python (available: ${Boolean(pythonProbe?.available)}), node (available: ${Boolean(nodeProbe?.available)})`);
    stdout("  trusted-local: available");
    stdout("  sandbox: unavailable (unverified target host; public author submissions disabled)");
    stdout("  compiler: unavailable for untrusted C++/Java (Python/Node isolated build available)");
    stdout("  isolated-build: available (python, node)");

    const getContainerProbe = io.probeContainerRuntime || (async () => {
      try {
        const mod = await import("../../../packages/arena-node/src/execution/container-executor.mjs");
        return mod.probeContainerRuntime();
      } catch (_) {
        return { available: false, verified: false, reason: "module_not_found" };
      }
    });

    const containerProbe = typeof getContainerProbe === "function" ? await getContainerProbe() : getContainerProbe;
    if (containerProbe?.available) {
      if (containerProbe.verified) {
        stdout(`  container-executor: verified (${containerProbe.serverOs}/${containerProbe.serverArch} ${containerProbe.dockerVersion})`);
      } else {
        stdout(`  container-executor: available (local-desktop-evidence; target-host unverified)`);
      }
    } else {
      stdout(`  container-executor: unavailable (${containerProbe?.reason || "runtime missing"})`);
    }
    stdout("Profiles:");
    const probed = registry.probeAll();
    for (const [profId, pInfo] of Object.entries(probed)) {
      if (pInfo.available) {
        stdout(`  ${profId}: available (${pInfo.version || pInfo.executable})`);
      } else {
        stdout(`  ${profId}: unavailable (${pInfo.error || "not found"})`);
      }
    }

    return 0;
  } catch (err) {
    stderr(`Infrastructure error during doctor diagnostics: ${err?.message || err}`);
    return 1;
  }
}

async function handleMatch(args, stdout, stderr, cwd, io = {}) {
  const parsed = parseMatchOptions(args);
  if (parsed.error) {
    stderr(`Error: ${parsed.error}`);
    return 2;
  }

  const opts = parsed.options;

  if (!opts.output) {
    stderr("Error: Missing required argument --output <path>.");
    return 2;
  }

  if (opts.kind !== "practice") {
    stderr(`Error: Unsupported match kind "${opts.kind}". Only "practice" is supported in milestone M1.`);
    return 2;
  }

  function isValidBotSpec(spec) {
    if (spec === "first-legal") return true;
    if (typeof spec === "string" && spec.startsWith("python:") && spec.slice(7).trim().length > 0) return true;
    return false;
  }

  if (!isValidBotSpec(opts.botA)) {
    stderr(`Error: Unsupported bot "${opts.botA}" for seat A. Only "first-legal" or "python:<source-path>" is supported.`);
    return 2;
  }

  if (!isValidBotSpec(opts.botB)) {
    stderr(`Error: Unsupported bot "${opts.botB}" for seat B. Only "first-legal" or "python:<source-path>" is supported.`);
    return 2;
  }

  const outputPath = path.resolve(cwd, opts.output);
  const parentDir = path.dirname(outputPath);

  // Path verified parent: Check parent directory exists before creating files
  if (!fs.existsSync(parentDir)) {
    stderr(`Error: Output parent directory "${parentDir}" does not exist.`);
    return 2;
  }

  // Pre-check destination file existence without overwrite
  if (fs.existsSync(outputPath) && !opts.overwrite) {
    stderr(`Error: Destination file "${outputPath}" already exists. Pass --overwrite to overwrite.`);
    return 2;
  }

  // Initialize referee components
  let engine, clock, journal, rulesetSnapshot, rulesetHash, engineRevision;
  try {
    engine = io.getEngine ? io.getEngine() : createNodeEngine();
    clock = io.getClock ? io.getClock() : createNodeClock();
    journal = io.getJournal ? io.getJournal() : createReplayJournal();
    rulesetSnapshot = io.getRulesetSnapshot
      ? io.getRulesetSnapshot()
      : createCurrentRulesetSnapshot(coreConfig);
    rulesetHash = io.getRulesetHash
      ? io.getRulesetHash(rulesetSnapshot)
      : computeRulesetHash(rulesetSnapshot);
    engineRevision = io.getEngineFingerprint
      ? io.getEngineFingerprint()
      : computeCurrentEngineFingerprint();
  } catch (err) {
    stderr(`Infrastructure error during referee setup: ${err?.message || err}`);
    return 1;
  }

  const matchId = `practice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const registry = io.getRegistry ? io.getRegistry() : createProfileRegistry();

  let botA, botB;
  try {
    botA = registry.resolveBot(opts.botA, {
      botId: opts.botA.startsWith("python:")
        ? `python-a-${path.basename(opts.botA.slice(7), ".py")}`
        : "first-legal-a",
      cwd,
      clock
    });
  } catch (errA) {
    if (errA && errA.kind === "infrastructure_error") {
      stderr(`Infrastructure error: ${errA.code || errA.message}`);
      return 1;
    }
    stderr(`Error: Failed resolving bot A: ${errA.message}`);
    return 2;
  }

  try {
    botB = registry.resolveBot(opts.botB, {
      botId: opts.botB.startsWith("python:")
        ? `python-b-${path.basename(opts.botB.slice(7), ".py")}`
        : "first-legal-b",
      cwd,
      clock
    });
  } catch (errB) {
    if (errB && errB.kind === "infrastructure_error") {
      stderr(`Infrastructure error: ${errB.code || errB.message}`);
      return 1;
    }
    stderr(`Error: Failed resolving bot B: ${errB.message}`);
    return 2;
  }

  const controller = createHeadlessMatchController({
    matchId,
    engine,
    botA,
    botB,
    clock,
    journal,
    policy: DEFAULT_MATCH_POLICY,
    rulesetSnapshot,
    rulesetHash,
    engineRevision,
    participants: {
      A: {
        botId: botA.botId || "bot-a",
        name: opts.botA,
        isFunctionBot: !opts.botA.startsWith("python:")
      },
      B: {
        botId: botB.botId || "bot-b",
        name: opts.botB,
        isFunctionBot: !opts.botB.startsWith("python:")
      }
    }
  });

  let result;
  try {
    result = await controller.run();
  } catch (err) {
    stderr(`Infrastructure error during match execution: ${err?.message || err}`);
    return 1;
  }

  if (result.kind === "infrastructure_error") {
    stderr(`Infrastructure error: ${result.code}`);
    return 1;
  }

  // Retrieve and validate replay document
  const replay = journal.getDocument();
  if (!replay) {
    stderr("Infrastructure error: Journal failed to produce finalized replay document.");
    return 1;
  }

  const validation = validateReplayDocument(replay);
  if (!validation.ok) {
    stderr(`Infrastructure error: Replay validation failed: ${JSON.stringify(validation.errors)}`);
    return 1;
  }

  const digest = computeReplayDigest(replay);

  if (typeof io.onBeforePublish === "function") {
    await io.onBeforePublish();
  }

  // Atomic file write: write to unique temporary file with 'wx' flag, then publish
  const tempPath = path.join(
    parentDir,
    `.${path.basename(outputPath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    fs.writeFileSync(tempPath, JSON.stringify(replay, null, 2), { flag: "wx", encoding: "utf8" });

    if (opts.overwrite) {
      fs.renameSync(tempPath, outputPath);
    } else {
      try {
        fs.linkSync(tempPath, outputPath);
        fs.unlinkSync(tempPath);
      } catch (linkErr) {
        if (linkErr.code === "EEXIST") {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch (_) {}
          stderr(`Error: Destination file "${outputPath}" already exists. Pass --overwrite to overwrite.`);
          return 2;
        }
        throw linkErr;
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    stderr(`Infrastructure error: Failed writing replay to "${outputPath}": ${err.message}`);
    return 1;
  }

  stdout(`Match completed: ${result.outcome}`);
  stdout(`Winner: ${result.winner || "none"}`);
  stdout(`Reason: ${result.reason}`);
  stdout(`Accepted plies: ${result.acceptedPlies}`);
  stdout(`Replay digest: ${digest}`);
  stdout(`Replay written to: ${outputPath}`);

  return 0;
}

// Direct CLI invocation
const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("apps/arena-cli/src/main.mjs") ||
    process.argv[1].endsWith("apps\\arena-cli\\src\\main.mjs"));

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
