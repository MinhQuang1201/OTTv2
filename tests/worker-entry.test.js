const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const workerEntry = fs.readFileSync(path.join(root, 'workers', 'ott-worker.ts'), 'utf8');
const gameServer = fs.readFileSync(path.join(root, 'workers', 'ott-game-server.ts'), 'utf8');
const lobbyServer = fs.readFileSync(path.join(root, 'workers', 'ott-lobby-server.ts'), 'utf8');
const wrangler = fs.readFileSync(path.join(root, 'workers', 'wrangler.jsonc'), 'utf8');
const workerConfiguration = fs.readFileSync(path.join(root, 'workers', 'worker-configuration.d.ts'), 'utf8');
const workerRuntime = fs.readFileSync(path.join(root, 'tests', 'worker-runtime.test.js'), 'utf8');
const workerConfig = JSON.parse(fs.readFileSync(path.join(root, 'workers', 'wrangler.jsonc'), 'utf8'));

test('Worker routes the YProvider party path through PartyServer', () => {
  assert.match(workerEntry, /from ["']partyserver["']/);
  assert.doesNotMatch(workerEntry, /node_modules\/playhtml\/node_modules\/partyserver/);
  assert.match(workerEntry, /routePartykitRequest/);
  assert.match(workerEntry, /PUBLIC_ROOM_PATH/);
  assert.match(workerEntry, /ott-\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
  assert.match(workerEntry, /request\.url/);
  assert.match(workerEntry, /status:\s*404/);
  assert.match(wrangler, /"name"\s*:\s*"Main"/);
  assert.match(wrangler, /"class_name"\s*:\s*"OttGameServer"/);
  assert.doesNotMatch(wrangler, /"name"\s*:\s*"OTT_GAME"/);
  assert.doesNotMatch(workerConfiguration, /OTT_GAME/);
  const routeSource = workerEntry.match(/const PUBLIC_ROOM_PATH = (\/.*\/);/)[1];
  const route = new RegExp(routeSource.slice(1, -1));
  const room = 'ott-123e4567-e89b-12d3-a456-426614174000';
  assert.equal(route.test(`/parties/main/${room}`), true);
  assert.equal(route.test(`/parties/main/${room}/`), false, 'the canonical public route must not accept a trailing slash');
  assert.equal(route.test(`/parties/main/${room.toUpperCase()}`), false, 'the public room route must remain lowercase');
});

test('Lobby initializes the canonical public room through Main', () => {
  assert.match(lobbyServer, /this\.env\.Main\.get\(this\.env\.Main\.idFromName\(allocation\.roomId\)\)/);
  assert.doesNotMatch(lobbyServer, /OTT_GAME/);
});

test('Task 1 ships no routing probe or browser-facing transport harness', () => {
  assert.doesNotMatch(workerEntry, /OTT_TEST_ROUTING_PROBE_SECRET|test-routing-identity|x-ott-test-routing-probe/);
  assert.doesNotMatch(gameServer, /OTT_TEST_ROUTING_PROBE_SECRET|test-routing-identity|x-ott-test-routing-probe/);
  assert.doesNotMatch(workerConfiguration, /OTT_TEST_ROUTING_PROBE_SECRET/);
  assert.doesNotMatch(workerRuntime, /OTT_TEST_ROUTING_PROBE_SECRET|routingIdentity|upgradeWithRawHttp|Switching Protocols/);
});

test('game server delegates Yjs lifecycle and keeps OTT dispatch at the custom boundary', () => {
  assert.match(gameServer, /from ["']y-partyserver["']/);
  assert.doesNotMatch(gameServer, /node_modules\/playhtml\/node_modules\/y-partyserver/);
  assert.match(gameServer, /extends\s+YServer/);
  assert.match(gameServer, /onConnect\(/);
  assert.match(gameServer, /onMessage\(/);
  assert.match(gameServer, /onClose\(/);
  assert.match(gameServer, /isReadOnly\(/);
  assert.match(gameServer, /onCustomMessage/);
  assert.match(gameServer, /parseOttMessage/);
  assert.doesNotMatch(gameServer, /supabase|partysocket|presence|sharing|admin/i);
});

test('minimal Worker does not enable presence or a second transport', () => {
  assert.doesNotMatch(workerEntry, /PartySocket|WebSocket|presence|connectUsersPresenceTransport/i);
  assert.doesNotMatch(gameServer, /PartySocket|WebSocket|presence|connectUsersPresenceTransport/i);
});

test('browser demo clock stays within the persisted Room schema maximum', () => {
  const initialClockMs = Number(workerConfig.env.demo.vars.OTT_TEST_CLOCK_MS);
  const roomClockLimitMs = require('../config').TIME_CONTROL.initialMs;
  assert.ok(initialClockMs > 0 && initialClockMs <= roomClockLimitMs);
});
