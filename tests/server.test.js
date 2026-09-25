const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { server } = require("../server");

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
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
    "/tests/room.test.js", "/TeStS/room.test.js", "/TESTS/ROOM.TEST.JS",
    "/node_modules/playhtml/package.json", "/NoDe_MoDuLeS/playhtml/package.json", "/NODE_MODULES/PLAYHTML/PACKAGE.JSON"
  ];

  for (const pathname of paths) {
    assert.equal(await request(port, pathname), 403, pathname);
  }
});

test("serves a public asset", async () => {
  const port = server.address().port;
  assert.equal(await request(port, "/index.html"), 200);
});
