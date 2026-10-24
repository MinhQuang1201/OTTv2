/**
 * Writes a secret position set for behaviour fingerprints (plan §8.5): 100 positions for everyone, 300 for the Top 32.
 * The file stays on the organisers' runner machine (var/ is outside git); its SHA-256 is what the admin page asks for.
 * Never commit, publish or send the file: a team that knows the positions could special-case them.
 *
 *   node scripts/bot-cup/probe-positions.mjs [--count 100] [--out var/bot-cup/probe-sets/<name>.json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateProbePositions, probeSetText } from "../../packages/bot-cup-core/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const count = Number(option("count", "100"));
if (!Number.isInteger(count) || count < 20 || count > 1000) {
  console.error("--count must be 20..1000");
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 10);
const out = path.resolve(option("out", path.join(ROOT, "var/bot-cup/probe-sets", `${stamp}-${count}-${crypto.randomBytes(3).toString("hex")}.json`)));
if (fs.existsSync(out)) {
  console.error(`${out} exists; a set must never change once fingerprints were taken with it`);
  process.exit(1);
}
// Cryptographic randomness: the set must not be reproducible from a seed someone could guess.
const random = () => crypto.randomInt(2 ** 32) / 2 ** 32;
const text = probeSetText(generateProbePositions({ count, random }));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, { flag: "wx" });
const sha256 = crypto.createHash("sha256").update(text).digest("hex");
console.log(JSON.stringify({ file: path.relative(ROOT, out), positions: count, sha256 }, null, 2));
console.log("Giữ file này trên máy runner, không commit hay gửi đi. Dán SHA-256 vào trang BTC → Cờ gian lận → Chạy vân tay hành vi.");
