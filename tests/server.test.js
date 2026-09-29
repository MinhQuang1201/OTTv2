const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { server } = require("../server");

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname }, (res) => {
      const headers = res.headers;
      res.resume();
      res.on("end", () => resolve({ statusCode: res.statusCode, headers }));
    });
    req.on("error", reject);
  });
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("denies private source, test, and runtime paths regardless of case", async () => {
  const port = server.address().port;
  const paths = [
    "/server.js", "/SeRvEr.Js", "/SERVER.JS",
    "/room.js", "/RoOm.Js", "/ROOM.JS",
    "/package.json", "/PaCkAgE.JsOn", "/PACKAGE.JSON",
    "/package-lock.json", "/PaCkAgE-LoCk.JsOn", "/PACKAGE-LOCK.JSON",
    "/.env", "/.EnV", "/.ENV",
    "/.env.example", "/.EnV.ExAmPlE", "/.ENV.EXAMPLE",
    "/partykit.json", "/PaRtYkIt.JsOn", "/PARTYKIT.JSON",
    "/partykit/ott-room.js", "/PaRtYkIt/ott-room.js", "/PARTYKIT/OTT-ROOM.JS",
    "/apps/worker/wrangler.jsonc", "/ApPs/WoRkEr/wrangler.jsonc", "/APPS/WORKER/WRANGLER.JSONC",
    "/apps/worker/README.md", "/packages/protocol/src/index.ts", "/packages/game-core/src/room.js",
    "/tests/room.test.js", "/TeStS/room.test.js", "/TESTS/ROOM.TEST.JS",
    "/node_modules/playhtml/package.json", "/NoDe_MoDuLeS/playhtml/package.json", "/NODE_MODULES/PLAYHTML/PACKAGE.JSON",
    "/%2e%2e%2fserver.js", "/apps/worker/%2e%2e/server.js",
    "/assets/../apps/worker/wrangler.jsonc", "/assets/%2e%2e/apps/worker/wrangler.jsonc"
  ];

  for (const pathname of paths) {
    assert.equal((await request(port, pathname)).statusCode, 403, pathname);
  }
});

test("denies a public-path symlink to a file outside the project", async () => {
  const root = path.resolve(__dirname, "..");
  const name = `server-test-outside-${process.pid}-${Date.now()}`;
  const linkPath = path.join(root, "apps", "web", "dist", name);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ott-server-test-"));
  const targetPath = path.join(tempDir, "outside.txt");

  try {
    await fs.writeFile(targetPath, "private");
    await fs.symlink(tempDir, linkPath, "junction");
    assert.equal((await request(server.address().port, `/${name}/outside.txt`)).statusCode, 403);
  } finally {
    await fs.unlink(linkPath).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("denies a public-path symlink into a private project directory", async () => {
  const root = path.resolve(__dirname, "..");
  const name = `server-test-worker-${process.pid}-${Date.now()}`;
  const linkPath = path.join(root, "apps", "web", "dist", name);

  try {
    await fs.symlink(path.join(root, "apps", "worker"), linkPath, "junction");
    assert.equal((await request(server.address().port, `/${name}/wrangler.jsonc`)).statusCode, 403);
  } finally {
    await fs.unlink(linkPath).catch(() => {});
  }
});

test("serves a public asset", async () => {
  const port = server.address().port;
  const index = await request(port, "/index.html");
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["content-type"], /^text\/html/);
  assert.equal((await request(port, "/playhtml-game.html")).statusCode, 200);
});

test("serves only the built React app", async () => {
  const port = server.address().port;
  assert.equal((await request(port, "/src/main.tsx")).statusCode, 404);
  assert.equal((await request(port, "/apps/web/src/legacy/game.js")).statusCode, 404);
  assert.equal((await request(port, "/packages/game-client/src/playhtml-bootstrap.js")).statusCode, 404);
});
