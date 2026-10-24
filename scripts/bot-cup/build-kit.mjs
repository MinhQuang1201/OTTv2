/**
 * Packs the Bot Cup starter kit (plan §6.4): the two templates, the guide, and judge.mjs bundled into one file that needs
 * only Node 22 (no clone of this repository, no npm install).
 *
 *   npm run bot-cup:kit          # writes var/bot-cup/kit/
 *
 * The web build publishes the same files under /bot-cup-kit/ (apps/web/vite.config.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KIT = path.join(ROOT, "sdk/bot-cup");
export const OUT = path.join(ROOT, "var/bot-cup/kit");

// node-engine.mjs loads rules.js and config.js through createRequire with computed paths, which a bundle cannot follow.
// Swap those two lines for static imports so the bundle carries the same files.
const staticGameCore = {
  name: "static-game-core",
  setup(builder) {
    builder.onLoad({ filter: /node-engine\.mjs$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      const patched = source
        .replace("const defaultRules = require(coreRulesPath);", 'import defaultRules from "../../../game-core/src/rules.js";')
        .replace("const defaultConfig = require(coreConfigPath);", 'import defaultConfig from "../../../game-core/src/config.js";');
      if (patched === source || patched.includes("require(core")) throw new Error("node-engine.mjs changed; update scripts/bot-cup/build-kit.mjs");
      return { contents: patched, loader: "js" };
    });
  }
};

/** @returns {Promise<Record<string, string>>} file name -> contents */
export async function kitFiles() {
  const bundled = await build({
    entryPoints: [path.join(KIT, "judge.mjs")],
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    plugins: [staticGameCore],
    // ai.js is CommonJS and calls require(); give the ES module bundle a require of its own.
    banner: { js: "import { createRequire as __ottCreateRequire } from 'node:module'; const require = __ottCreateRequire(import.meta.url);" },
    logLevel: "warning"
  });
  return {
    "judge.mjs": bundled.outputFiles[0].text,
    "bot.py": fs.readFileSync(path.join(KIT, "python/bot.py"), "utf8"),
    "bot.mjs": fs.readFileSync(path.join(KIT, "js/bot.mjs"), "utf8"),
    "GUIDE.vi.md": fs.readFileSync(path.join(KIT, "GUIDE.vi.md"), "utf8")
  };
}

export async function buildKit(out = OUT) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, contents] of Object.entries(await kitFiles())) fs.writeFileSync(path.join(out, name), contents);
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  buildKit().then((out) => {
    console.log(`starter kit: ${path.relative(ROOT, out)}`);
    for (const name of fs.readdirSync(out)) console.log(`  ${name}  ${fs.statSync(path.join(out, name)).size} B`);
  });
}
