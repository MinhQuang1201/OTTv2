const Y = require("yjs");
const YProvider = require("y-partyserver/provider").default;
const { createMinimalPlayhtml } = require("./index.js");

const GAME_ROOM_ID = /^ott-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOBBY_ROOM_ID = /^ott-lobby-public$/;
let configuration = null;
let instance = null;

function parseHost(value) {
  const url = new URL(value, globalThis.location && globalThis.location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("PlayHTML host must use HTTP or HTTPS");
  }
  return {
    host: url.host,
    protocol: url.protocol === "https:" || url.protocol === "wss:" ? "wss" : "ws",
  };
}

function configure(options) {
  if (!options || typeof options.host !== "string" || typeof options.room !== "string") {
    throw new TypeError("PlayHTML requires a host and canonical OTT room ID");
  }
  const party = options.party || "main";
  if (party === "main" && !GAME_ROOM_ID.test(options.room)) {
    throw new TypeError("PlayHTML requires a host and canonical OTT room ID");
  }
  if (party === "lobby" && !LOBBY_ROOM_ID.test(options.room)) {
    throw new TypeError("PlayHTML requires a valid lobby room ID");
  }
  if (party !== "main" && party !== "lobby") {
    throw new TypeError("Unsupported party");
  }
  const parsed = parseHost(options.host);
  const next = { ...parsed, room: options.room, party };
  if (configuration && (configuration.host !== next.host || configuration.protocol !== next.protocol || configuration.room !== next.room || configuration.party !== next.party)) {
    throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
  }
  configuration = next;
}

function init() {
  if (!configuration) throw new Error("PlayHTML runtime must be configured before init");
  if (instance) return instance;

  const doc = new Y.Doc();
  const provider = new YProvider(configuration.host, configuration.room, doc, {
    party: configuration.party,
    protocol: configuration.protocol,
    disableBc: true,
    resyncInterval: -1,
  });
  let synced = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimeout = setTimeout(() => rejectReady(new Error("PlayHTML YProvider sync timed out")), 15_000);
  provider.on("synced", (value) => {
    if (value && !synced) {
      synced = true;
      clearTimeout(readyTimeout);
      resolveReady();
    }
  });
  provider.on("connection-error", () => {
    if (!synced) {
      clearTimeout(readyTimeout);
      rejectReady(new Error("PlayHTML YProvider connection failed"));
    }
  });

  const playhtml = createMinimalPlayhtml({ ready, provider });
  instance = {
    ...playhtml,
    provider,
    close() {
      clearTimeout(readyTimeout);
      provider.destroy();
      instance = null;
    },
  };
  return instance;
}

function reset() {
  if (instance) {
    try { instance.close(); } catch (_) {}
    instance = null;
  }
  configuration = null;
}

const runtime = { configure, init, reset };
if (typeof globalThis !== "undefined") globalThis.OTT_PLAYHTML_RUNTIME = runtime;
module.exports = runtime;
