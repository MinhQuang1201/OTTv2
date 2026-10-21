const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function fixture(t, options = {}) {
  const { openDatabase } = await import('../packages/arena-node/src/persistence/sqlite-database.mjs');
  const { createArenaServer } = await import('../apps/arena-api/src/http-server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'arena-registration-'));
  const dbPath = join(dir, 'arena.db');
  const { db } = openDatabase(dbPath);
  const server = createArenaServer({ db, publicRegistration: true, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}/api/arena/v1`;
    async function request(body, { path = '/auth/register', method = 'POST', contentType = 'application/json', raw = false, requestOrigin } = {}) {
      const headers = contentType ? { 'Content-Type': contentType } : {};
      if (requestOrigin) headers.Origin = requestOrigin;
      const response = await fetch(origin + path, {
        method, headers,
      ...((method !== 'GET' && method !== 'HEAD') ? { body: raw ? body : JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
    return { db, dbPath, request, origin };
}

test('registration creates only a persistent active author, hashed password and no session; old login works', async t => {
  const { db, dbPath, request } = await fixture(t);
  const password = '  demo password  ';
  const result = await request({ username: '  Demo.User  ', password });
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.body), ['user']);
  assert.match(result.body.user.id, /^usr-/);
  assert.equal(result.body.user.username, 'demo.user');
  assert.equal(result.body.user.role, 'author');
  const row = db.prepare('SELECT * FROM users').get();
  const { verifyPassword } = await import('../apps/arena-api/src/auth/accounts.mjs');
  assert.equal(row.status, 'active');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(verifyPassword(password, row.password_hash), true);
  assert.equal(verifyPassword(password.trim(), row.password_hash), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
  const { openDatabase } = await import('../packages/arena-node/src/persistence/sqlite-database.mjs');
  const second = openDatabase(dbPath).db;
  try { assert.equal(second.prepare('SELECT normalized_username FROM users').get().normalized_username, 'demo.user'); }
  finally { second.close(); }
  const login = await request({ username: 'DEMO.USER', password }, { path: '/auth/login' });
  assert.equal(login.status, 200);
  assert.equal(typeof login.body.token, 'string');
});

test('registration validates payload shape, policy, methods, media types and bounded body', async t => {
  const { request } = await fixture(t);
  for (const body of [null, [], 3, 'text', {}, { username: 3, password: 'password' }, { username: 'demo', password: 9 }, { username: 'demo', password: 'password', role: 'admin' }, { username: 'demo', password: 'password', status: 'active' }, { username: 'demo', password: 'password', id: 'injected' }]) {
    const result = await request(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error.code, 'INVALID_PAYLOAD');
  }
  for (const body of [{ username: 'ab', password: 'password' }, { username: 'a'.repeat(33), password: 'password' }, { username: 'bad/name', password: 'password' }, { username: 'demo', password: 'short' }, { username: 'demo', password: 'p'.repeat(129) }]) {
    assert.equal((await request(body)).status, 422);
  }
  assert.equal((await request('{', { raw: true })).status, 400);
  assert.equal((await request({}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await request('{}', { raw: true, contentType: null })).status, 415);
  const wrongMethod = await request(null, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await request({ username: 'big', password: 'p'.repeat(9000) })).status, 413);
  assert.equal((await request({ username: 'valid-name_1', password: 'p'.repeat(128) }, { contentType: 'application/json; charset=utf-8' })).status, 201);
});

test('registration flag defaults off and capabilities advertise explicit setting', async t => {
  const { request } = await fixture(t, { publicRegistration: undefined });
  for (const method of ['POST', 'GET', 'PUT']) {
    const result = await request({}, { method });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'REGISTRATION_DISABLED');
  }
  const capabilities = await request(null, { path: '/capabilities', method: 'GET' });
  assert.equal(capabilities.body.publicRegistration, false);
});

test('registration response uses the exact CORS allowlist and honors a smaller server body limit', async t => {
  const { request } = await fixture(t, {
    allowedOrigins: ['http://demo.local'],
    maxBodyBytes: 128
  });

  const allowed = await request({ username: 'cors-user', password: 'password' }, {
    contentType: 'application/json',
    requestOrigin: 'http://demo.local'
  });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://demo.local');

  const tooLarge = await request({ username: 'small-limit', password: 'p'.repeat(128) });
  assert.equal(tooLarge.status, 413);
});

test('case-insensitive concurrent registration across connections creates exactly one user', async t => {
  const { db, dbPath, request } = await fixture(t);
  const { openDatabase } = await import('../packages/arena-node/src/persistence/sqlite-database.mjs');
  const { createArenaServer } = await import('../apps/arena-api/src/http-server.mjs');
  const second = openDatabase(dbPath).db;
  const server = createArenaServer({ db: second, publicRegistration: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await Promise.all([
      request({ username: 'Race', password: 'password' }),
      fetch(`http://127.0.0.1:${server.address().port}/api/arena/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'RACE', password: 'password' }) })
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal((await request({ username: 'race', password: 'password' })).body.error.code, 'USERNAME_TAKEN');
  } finally {
    await new Promise(resolve => server.close(resolve));
    second.close();
  }
});

test('unrelated database constraints return generic internal error without SQL disclosure', async t => {
  const { db, request } = await fixture(t);
  db.exec("CREATE TRIGGER reject_registration BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'private database failure'); END");
  const result = await request({ username: 'demo', password: 'password' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(result.body).includes('private database'), false);
});

test('configuration enables registration only explicitly and supports override', async () => {
  const { loadConfig, DEFAULT_CONFIG } = await import('../apps/arena-api/src/config.mjs');
  const previous = process.env.ARENA_PUBLIC_REGISTRATION;
  try {
    delete process.env.ARENA_PUBLIC_REGISTRATION;
    assert.equal(DEFAULT_CONFIG.publicRegistration, false);
    assert.equal(loadConfig().publicRegistration, false);
    process.env.ARENA_PUBLIC_REGISTRATION = 'true';
    assert.equal(loadConfig().publicRegistration, true);
    assert.equal(loadConfig({ publicRegistration: false }).publicRegistration, false);
  } finally {
    if (previous === undefined) delete process.env.ARENA_PUBLIC_REGISTRATION;
    else process.env.ARENA_PUBLIC_REGISTRATION = previous;
  }
});

test('startArenaService propagates public registration to the live HTTP server', async t => {
  const { startArenaService } = await import('../apps/arena-api/src/main.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'arena-registration-main-'));
  const service = await startArenaService({
    bind: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'arena.db'),
    storageDir: join(dir, 'artifacts'),
    publicRegistration: true,
    trustedMode: true,
    externalWorker: true
  });
  t.after(async () => {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const address = service.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/arena/v1/capabilities`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).publicRegistration, true);
});
