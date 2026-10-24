/**
 * JPlag pass over Bot Cup submissions (plan §8.5, layer 2), run by organisers on their own machine:
 *
 *   1. Trang BTC → Cờ gian lận → "Tải gói mã" (sealed after code freeze) → bot-cup-sources-sealed.json
 *   2. node scripts/bot-cup/similarity.mjs --bundle bot-cup-sources-sealed.json
 *   3. Trang BTC → Cờ gian lận → "Nhập báo cáo JPlag" → the report.json this script printed
 *
 * Submissions are compared per language (Python 3 / JavaScript) with each other and with the public reference corpus
 * (ai.js, house bots, SDK examples). The starter templates are JPlag "base code": what every team was given does not
 * count as copying. Pairs ≥ 70% become flags on import, ≥ 85% are marked for priority review. A copy translated to the
 * other language is the behaviour fingerprints' job, not JPlag's.
 *
 * Options: --jar <jplag jar> (default: newest var/bot-cup/jplag/*.jar; JPlag 6.2.0 runs on Java 21)
 *          --out <dir> (default var/bot-cup/similarity/<time>)   --min-tokens <n> (default 9)   --keep <0..1> (default 0.5)
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REFERENCE_FILES } from "./reference-hashes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCES_FORMAT = "ott-bot-cup-sources-1";
export const REPORT_FORMAT = "ott-bot-cup-jplag-1";

/** Per Bot Cup language: the JPlag module, file suffix, the template given to everyone (base code). */
export const LANGUAGES = Object.freeze({
  python: { jplag: "python3", suffix: ".py", base: "sdk/bot-cup/python/bot.py" },
  node: { jplag: "javascript", suffix: ".js", base: "sdk/bot-cup/js/bot.mjs" }
});

const REFERENCE_PREFIX = "ref~";

function languageOfFile(file) {
  return file.endsWith(".py") ? "python" : file.endsWith(".js") || file.endsWith(".mjs") ? "node" : null;
}

/** Folder name JPlag shows for a reference file. */
export function referenceName(file) {
  return `${REFERENCE_PREFIX}${file.replace(/[^\w.-]+/g, "~")}`;
}

/**
 * Lays out one JPlag workspace per language: subs/<submission id>/bot<suffix>, subs/ref~<file>/…, base/template.
 * @returns {Record<string, { dir: string, submissions: number, references: Map<string, string> }>}
 */
export function buildWorkspace(bundle, outDir, { root = ROOT, references = REFERENCE_FILES } = {}) {
  if (bundle?.format !== SOURCES_FORMAT || !Array.isArray(bundle.submissions)) throw new Error("not a Bot Cup source bundle");
  const workspaces = {};
  for (const [language, spec] of Object.entries(LANGUAGES)) {
    const dir = path.join(outDir, language);
    const own = bundle.submissions.filter((submission) => submission.language === language);
    if (!own.length) continue;
    fs.mkdirSync(path.join(dir, "subs"), { recursive: true });
    for (const submission of own) {
      if (!/^[\w-]{1,80}$/.test(submission.id)) throw new Error(`bad submission id ${submission.id}`);
      fs.mkdirSync(path.join(dir, "subs", submission.id));
      fs.writeFileSync(path.join(dir, "subs", submission.id, `bot${spec.suffix}`), submission.source ?? "");
    }
    const referenceNames = new Map();
    for (const file of references.filter((item) => languageOfFile(item) === language && item !== spec.base)) {
      const name = referenceName(file);
      fs.mkdirSync(path.join(dir, "subs", name));
      fs.copyFileSync(path.join(root, file), path.join(dir, "subs", name, `ref${spec.suffix}`));
      referenceNames.set(name, file);
    }
    fs.mkdirSync(path.join(dir, "base"));
    fs.copyFileSync(path.join(root, spec.base), path.join(dir, "base", `template${spec.suffix}`));
    workspaces[language] = { dir, submissions: own.length, references: referenceNames };
  }
  return workspaces;
}

/** JPlag's results.csv: submissionName1,submissionName2,averageSimilarity,maxSimilarity */
export function parseResultsCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(",");
  const at = (name) => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`results.csv has no ${name} column`);
    return index;
  };
  const [first, second, average, max] = ["submissionName1", "submissionName2", "averageSimilarity", "maxSimilarity"].map(at);
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    return { first: cells[first], second: cells[second], average: Number(cells[average]), max: Number(cells[max]) };
  });
}

/** Report rows for the admin import: submission pairs and submission-reference pairs at or above `keep`. */
export function reportPairs(rows, { language, references, keep = 0.5 }) {
  const pairs = [];
  for (const row of rows) {
    if (!(row.average >= keep)) continue;
    const firstRef = references.get(row.first);
    const secondRef = references.get(row.second);
    if (firstRef && secondRef) continue;
    const round = (value) => Math.round(value * 1000) / 1000;
    if (firstRef || secondRef) {
      pairs.push({ a: firstRef ? row.second : row.first, b: null, reference: firstRef ?? secondRef, similarity: round(row.average), max: round(row.max), language });
    } else {
      pairs.push({ a: row.first, b: row.second, reference: null, similarity: round(row.average), max: round(row.max), language });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

export function newestJar(dir = path.join(ROOT, "var/bot-cup/jplag")) {
  if (!fs.existsSync(dir)) return null;
  const jars = fs.readdirSync(dir).filter((file) => /^jplag-.*\.jar$/.test(file)).sort();
  return jars.length ? path.join(dir, jars.at(-1)) : null;
}

/**
 * Runs JPlag in the workspace with relative paths only: Java on Windows mangles non-ASCII arguments, and the repository
 * path here has Vietnamese letters.
 */
export function runJplag({ jar, workspace, language, minTokens = 9 }) {
  const args = [
    "-jar", path.relative(workspace.dir, jar), "-l", LANGUAGES[language].jplag, "-M", "RUN", "--csv-export", "--overwrite",
    "-r", "result", "-t", String(minTokens), "-bc", "base", "subs"
  ];
  const result = spawnSync("java", args, { cwd: workspace.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const csv = path.join(workspace.dir, "result", "results.csv");
  if (result.status !== 0 || !fs.existsSync(csv)) {
    throw new Error(`JPlag failed for ${language} (exit ${result.status}): ${(result.stderr || result.stdout || "").slice(-2000)}`);
  }
  return { csv: fs.readFileSync(csv, "utf8"), viewer: path.join(workspace.dir, "result.jplag") };
}

export function jplagVersion(jar) {
  return path.basename(jar).match(/jplag-([\d.]+)/)?.[1] ?? "unknown";
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const bundlePath = option("bundle");
  if (!bundlePath) throw new Error("--bundle <bot-cup-sources-*.json> is required");
  const bundleText = fs.readFileSync(bundlePath, "utf8");
  const bundle = JSON.parse(bundleText);
  const jar = option("jar") ? path.resolve(option("jar")) : newestJar();
  if (!jar || !fs.existsSync(jar)) throw new Error("JPlag jar not found: download a release jar into var/bot-cup/jplag/ or pass --jar");
  const outDir = path.resolve(option("out", path.join(ROOT, "var/bot-cup/similarity", new Date().toISOString().replace(/[:.]/g, "-"))));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const minTokens = Number(option("min-tokens", "9"));
  const keep = Number(option("keep", "0.5"));

  const workspaces = buildWorkspace(bundle, outDir);
  const pairs = [];
  const viewers = [];
  for (const [language, workspace] of Object.entries(workspaces)) {
    if (workspace.submissions + workspace.references.size < 2) continue;
    const { csv, viewer } = runJplag({ jar, workspace, language, minTokens });
    pairs.push(...reportPairs(parseResultsCsv(csv), { language, references: workspace.references, keep }));
    viewers.push(viewer);
  }
  const report = {
    format: REPORT_FORMAT,
    tool: `JPlag ${jplagVersion(jar)}`,
    minTokens,
    bundle: { scope: bundle.scope, exportedAt: bundle.exportedAt, submissions: bundle.submissions.length, sha256: crypto.createHash("sha256").update(bundleText).digest("hex") },
    createdAt: Date.now(),
    pairs
  };
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const count = (threshold) => pairs.filter((pair) => pair.similarity >= threshold).length;
  console.log(JSON.stringify({ report: reportPath, pairs: pairs.length, atLeast70: count(0.7), atLeast85: count(0.85), viewers }, null, 2));
  console.log("Nhập report.json ở trang BTC → Cờ gian lận. Xem chi tiết từng cặp: java -jar <jar> -M VIEW <viewer>");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
