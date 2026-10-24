/**
 * Sources of the house bots (plan §1, §7.4) as single files a container can run with `node bot.mjs`:
 * easy/medium/hard bundle ai.js with the rules; sentinel and strategist are already standalone; first-legal is a few lines.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const FIRST_LEGAL = `import readline from "node:readline";
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  if (!line.trim()) return;
  const turn = JSON.parse(line);
  if (turn.type !== "turn") return;
  process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: turn.requestId, move: turn.legalMoves[0] }) + "\\n");
});
`;

async function bundleAi(level) {
  const result = await build({
    entryPoints: [path.join(ROOT, "apps/bot-cup-runner/house/ai-bot.mjs")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    define: { __HOUSE_LEVEL__: JSON.stringify(level) },
    // ai.js and rules.js are CommonJS; give the ES module bundle a require of its own.
    banner: { js: "import { createRequire as __houseRequire } from 'node:module'; const require = __houseRequire(import.meta.url);" },
    logLevel: "warning"
  });
  return result.outputFiles[0].text;
}

/** @returns {Promise<Record<string, string>>} house bot name -> ES module source */
export async function houseBotSources() {
  return {
    "first-legal": FIRST_LEGAL,
    easy: await bundleAi("easy"),
    medium: await bundleAi("medium"),
    hard: await bundleAi("hard"),
    sentinel: fs.readFileSync(path.join(ROOT, "bots/sentinel.mjs"), "utf8"),
    strategist: fs.readFileSync(path.join(ROOT, "bots/strategist.mjs"), "utf8")
  };
}
