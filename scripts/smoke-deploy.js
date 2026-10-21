// Post-deploy smoke test: node scripts/smoke-deploy.js --worker <url> --frontend <url>
// Checks the deployed Worker answers the frontend origin and the frontend bundle targets that Worker.
const FORBIDDEN_BUNDLE_MARKERS = ["OTT_INTERNAL_SECRET", "x-ott-internal-secret"];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    args[key.slice(2)] = value;
  }
  for (const name of ["worker", "frontend"]) {
    if (!args[name]) throw new Error(`Missing --${name} <url>`);
    args[name] = new URL(args[name]).origin;
  }
  return args;
}

async function withRetry(label, check, { attempts = 5, delayMs = 3000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label}: ${lastError.message}`);
}

async function checkControlList(worker, frontend) {
  const response = await fetch(`${worker}/control/list`, {
    method: "POST",
    headers: { origin: frontend, "content-type": "application/json" },
    body: "{}",
  });
  if (response.status !== 200) throw new Error(`expected HTTP 200, got ${response.status}`);
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin !== frontend) throw new Error(`expected CORS origin ${frontend}, got ${allowOrigin ?? "none"}`);
  const body = await response.json();
  if (!Array.isArray(body?.rooms)) throw new Error("response JSON has no rooms array");
  return body.rooms.length;
}

/** The live-match list the lobby shows when the spectator feature is on. */
async function checkSpectatorCatalog(worker, frontend) {
  const response = await fetch(`${worker}/control/active`, {
    method: "POST",
    headers: { origin: frontend, "content-type": "application/json" },
    body: "{}",
  });
  if (response.status !== 200) throw new Error(`expected HTTP 200, got ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.matches)) throw new Error("response JSON has no matches array");
  return body.matches.length;
}

async function checkFrontend(worker, frontend) {
  const page = await fetch(`${frontend}/`);
  if (page.status !== 200) throw new Error(`expected HTTP 200, got ${page.status}`);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) => new URL(match[1], frontend).href);
  if (scripts.length === 0) throw new Error("index.html references no script bundle");
  let targetsWorker = false;
  for (const src of scripts) {
    const bundle = await (await fetch(src)).text();
    const marker = FORBIDDEN_BUNDLE_MARKERS.find((name) => bundle.includes(name));
    if (marker) throw new Error(`bundle ${src} contains ${marker}`);
    if (bundle.includes(worker)) targetsWorker = true;
  }
  if (!targetsWorker) throw new Error(`no bundle references Worker ${worker}`);
  return scripts.length;
}

async function main(argv = process.argv.slice(2)) {
  const { worker, frontend } = parseArgs(argv.filter((arg) => arg !== "--spectator"));
  const rooms = await withRetry("Worker /control/list", () => checkControlList(worker, frontend));
  console.log(`ok worker ${worker} /control/list -> 200, ${rooms} room(s), CORS ${frontend}`);
  if (argv.includes("--spectator")) {
    const matches = await withRetry("Worker /control/active", () => checkSpectatorCatalog(worker, frontend));
    console.log(`ok worker ${worker} /control/active -> 200, ${matches} live match(es)`);
  }
  const bundles = await withRetry("Frontend", () => checkFrontend(worker, frontend));
  console.log(`ok frontend ${frontend} -> 200, ${bundles} bundle(s) target the Worker, no secret markers`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, checkControlList, checkSpectatorCatalog, checkFrontend, withRetry, main };
