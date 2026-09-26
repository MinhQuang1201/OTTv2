const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Playfull } = require("../playfull");

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  message(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
}

describe("Playfull resume lifecycle", () => {
  it("emits a dedicated resumeFailed event and clears stale credentials", async () => {
    const previous = global.WebSocket;
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    let client;
    try {
      client = new Playfull({ url: "ws://test" });
      const failures = [];
      client.on("resumeFailed", (msg) => failures.push(msg));
      const connecting = client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;

      client.resume("ABCD", "expired");
      assert.deepEqual(socket.sent.at(-1), {
        type: "resume",
        roomId: "ABCD",
        resumeToken: "expired"
      });
      socket.message({ type: "error", message: "expired" });

      assert.equal(failures.length, 1);
      assert.equal(failures[0].resumeFailure, true);
      assert.equal(client.resumeContext, null);
      assert.equal(client._resuming, false);
    } finally {
      client.close();
      global.WebSocket = previous;
    }
  });
});
