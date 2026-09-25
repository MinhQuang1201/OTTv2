const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlayhtmlBridge } = require("../partykit/playhtml-ott-bridge");

function fakeUpstream() {
  return {
    frames: [],
    handle(frame) {
      this.frames.push(frame);
    }
  };
}

function bridgeFor(upstream, received = []) {
  return createPlayhtmlBridge({
    upstream,
    onOttFrame: (frame) => received.push(frame)
  });
}

test("forwards non-OTT upstream frames byte-for-byte", () => {
  const upstream = fakeUpstream();
  const frame = new Uint8Array([0, 1, 2, 255]);

  bridgeFor(upstream).receive(frame);

  assert.equal(upstream.frames.length, 1);
  assert.strictEqual(upstream.frames[0], frame);
});

test("routes an explicit OTT envelope without touching upstream", () => {
  const upstream = fakeUpstream();
  const received = [];
  const frame = JSON.stringify({ __ott: true, type: "ott:ping", nonce: 7 });

  bridgeFor(upstream, received).receive(frame);

  assert.deepEqual(received, [{ __ott: true, type: "ott:ping", nonce: 7 }]);
  assert.deepEqual(upstream.frames, []);
});

test("forwards malformed JSON containing __ott unchanged", () => {
  const upstream = fakeUpstream();
  const received = [];
  const frame = '{"__ott":true,"type":';

  bridgeFor(upstream, received).receive(frame);

  assert.deepEqual(received, []);
  assert.deepEqual(upstream.frames, [frame]);
});

test("forwards upstream text containing __ott unchanged", () => {
  const upstream = fakeUpstream();
  const frame = "upstream payload mentioning __ott and ott:ping";

  bridgeFor(upstream).receive(frame);

  assert.deepEqual(upstream.frames, [frame]);
});

test("forwards upstream JSON containing __ott without the exact envelope", () => {
  const upstream = fakeUpstream();
  const frame = JSON.stringify({ __ott: false, type: "ott:ping" });

  bridgeFor(upstream).receive(frame);

  assert.deepEqual(upstream.frames, [frame]);
});

test("rejects an invalid OTT envelope without mutating dispatcher state", () => {
  const upstream = fakeUpstream();
  const received = [];
  const bridge = bridgeFor(upstream, received);

  bridge.receive(JSON.stringify({ __ott: true, type: "ping" }));

  assert.deepEqual(received, []);
  assert.deepEqual(upstream.frames, []);
});
