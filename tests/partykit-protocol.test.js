const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ERROR_CODES,
  MAX_MESSAGE,
  parseClientMessage,
  createRateLimiter,
  isValidStateResponse
} = require("../partykit/protocol");

function parse(value) {
  return parseClientMessage(typeof value === "string" ? value : JSON.stringify(value));
}

function assertCode(result, code) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { code });
}

test("rejects malformed JSON, non-object messages, and unsupported commands", () => {
  assertCode(parse("{"), ERROR_CODES.MALFORMED_JSON);
  assertCode(parse(null), ERROR_CODES.INVALID_MESSAGE);
  assertCode(parse([]), ERROR_CODES.INVALID_MESSAGE);
  assertCode(parse({}), ERROR_CODES.MISSING_TYPE);
  assertCode(parse({ type: "ott:nope" }), ERROR_CODES.UNSUPPORTED_TYPE);
  assertCode(parse({ type: "ott:list", extra: true }), ERROR_CODES.INVALID_PAYLOAD);
});

test("rejects messages over the 8KB UTF-8 limit", () => {
  const message = JSON.stringify({ type: "ott:create", name: "x".repeat(MAX_MESSAGE) });
  assertCode(parse(message), ERROR_CODES.MESSAGE_TOO_LARGE);
});

test("validates command payloads and keeps only the allowed shape", () => {
  assert.deepEqual(parse({ type: "ott:list" }), { ok: true, value: { type: "ott:list" } });
  assert.deepEqual(parse({ type: "ott:create", name: "Alice" }), {
    ok: true,
    value: { type: "ott:create", name: "Alice" }
  });
  assert.deepEqual(parse({ type: "ott:join", roomId: "ab12", name: "Alice" }), {
    ok: true,
    value: { type: "ott:join", roomId: "AB12", name: "Alice" }
  });
  assert.deepEqual(parse({ type: "ott:resume", roomId: "ab12", resumeToken: "opaque" }), {
    ok: true,
    value: { type: "ott:resume", roomId: "AB12", resumeToken: "opaque" }
  });
  assert.deepEqual(parse({
    type: "ott:move",
    from: { x: 1, y: 2 },
    to: { x: 2, y: 3 }
  }), {
    ok: true,
    value: { type: "ott:move", from: { x: 1, y: 2 }, to: { x: 2, y: 3 } }
  });
});

test("rejects malformed move coordinates, including nested objects and non-integers", () => {
  for (const message of [
    { type: "ott:move", from: { x: NaN, y: 1 }, to: { x: 2, y: 3 } },
    { type: "ott:move", from: { x: 1.5, y: 1 }, to: { x: 2, y: 3 } },
    { type: "ott:move", from: { x: "1", y: 1 }, to: { x: 2, y: 3 } },
    { type: "ott:move", from: { x: 1, y: 1 }, to: { x: 2, y: {} } },
    { type: "ott:move", from: { x: 1, y: 1, nested: { bad: true } }, to: { x: 2, y: 3 } },
    { type: "ott:move", from: { x: 1 }, to: { x: 2, y: 3 } }
  ]) {
    assertCode(parse(message), ERROR_CODES.INVALID_MOVE);
  }
});

test("validates room IDs and required string fields", () => {
  assertCode(parse({ type: "ott:join", roomId: "ABC", name: "Alice" }), ERROR_CODES.INVALID_ROOM_ID);
  assertCode(parse({ type: "ott:join", roomId: "ABCDE", name: "Alice" }), ERROR_CODES.INVALID_ROOM_ID);
  assertCode(parse({ type: "ott:join", roomId: "AB!2", name: "Alice" }), ERROR_CODES.INVALID_ROOM_ID);
  assertCode(parse({ type: "ott:join", roomId: "AB12", name: 4 }), ERROR_CODES.INVALID_NAME);
  assertCode(parse({ type: "ott:resume", roomId: "AB12", resumeToken: "" }), ERROR_CODES.INVALID_TOKEN);
  assertCode(parse({ type: "ott:create", name: "Alice", private: "state" }), ERROR_CODES.INVALID_PAYLOAD);
});

test("does not accept client ordering metadata and validates authoritative state shapes", () => {
  assertCode(parse({ type: "ott:ping", revision: 4 }), ERROR_CODES.INVALID_PAYLOAD);
  assertCode(parse({ type: "ott:move", from: { x: 1, y: 2 }, to: { x: 2, y: 3 }, id: 9 }), ERROR_CODES.INVALID_MOVE);

  const state = {
    type: "ott:state",
    roomId: "AB12",
    status: "playing",
    serverNow: 100,
    players: { A: null, B: null },
    state: {},
    revision: 4,
    events: [{ id: 1, type: "win" }]
  };
  assert.equal(isValidStateResponse(state), true);
  assert.equal(isValidStateResponse({ ...state, revision: 1.5 }), false);
  assert.equal(isValidStateResponse({ ...state, events: [{ id: 1 }, { id: 1 }] }), false);
  assert.equal(isValidStateResponse({ ...state, events: [{ id: 0 }] }), false);
  assert.equal(isValidStateResponse({ ...state, events: [{ id: "1" }] }), false);
  assert.equal(isValidStateResponse({ ...state, events: [{ id: 2 }, { id: 1 }] }), false);
});

test("returns stable non-leaking errors", () => {
  const result = parse({ type: "ott:resume", roomId: "AB12", resumeToken: "secret-token" });
  assert.equal(result.ok, true);
  const invalid = parse({ type: "ott:resume", roomId: "AB12", resumeToken: { secret: true } });
  assertCode(invalid, ERROR_CODES.INVALID_TOKEN);
  assert.doesNotMatch(JSON.stringify(invalid), /secret|stack|Error/);
});

test("rate-limits each connection independently at 40ms", () => {
  let now = 1000;
  const limiter = createRateLimiter({ now: () => now });
  const first = limiter.check("a");
  assert.equal(first.allowed, true);
  assert.equal(limiter.check("a").allowed, false);
  assert.equal(limiter.check("b").allowed, true);
  now += 40;
  assert.equal(limiter.check("a").allowed, true);
});

test("malformed, oversized, and rate-limited packets are rejected before dispatch", () => {
  const before = { turn: "A", pieces: [{ id: "piece", x: 1, y: 1 }] };
  let dispatched = 0;
  let now = 1000;
  const limiter = createRateLimiter({ now: () => now });

  for (const raw of ["{", JSON.stringify({ type: "ott:create", name: "x".repeat(MAX_MESSAGE) })]) {
    const parsed = parseClientMessage(raw);
    assert.equal(parsed.ok, false);
    assert.deepEqual(before, { turn: "A", pieces: [{ id: "piece", x: 1, y: 1 }] });
    assert.equal(dispatched, 0);
  }

  assert.equal(limiter.check("connection").allowed, true);
  assert.equal(limiter.check("connection").allowed, false);
  if (limiter.check("connection").allowed) dispatched += 1;
  now += 40;
  assert.equal(limiter.check("connection").allowed, true);
  assert.equal(dispatched, 0);
});
