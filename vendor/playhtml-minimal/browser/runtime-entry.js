const Y = require("yjs");
const YProvider = require("y-partyserver/provider").default;
const { createMinimalPlayhtml } = require("./index.js");

const ROOM_ID = /^ott-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  if (!options || typeof options.host !== "string" || typeof options.room !== "string" || !ROOM_ID.test(options.room)) {
    throw new TypeError("PlayHTML requires a host and canonical OTT room ID");
  }
  const parsed = parseHost(options.host);
  const next = { ...parsed, room: options.room };
  if (configuration && (configuration.host !== next.host || configuration.protocol !== next.protocol || configuration.room !== next.room)) {
    throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
  }
  configuration = next;
}

function init() {
  if (!configuration) throw new Error("PlayHTML runtime must be configured before init");
  if (instance) return instance;

  const doc = new Y.Doc();
  const provider = new YProvider(configuration.host, configuration.room, doc, {
    party: "main",
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
    close() {
      provider.destroy();
      instance = null;
    },
  };
  return instance;
}

const runtime = { configure, init };
if (typeof globalThis !== "undefined") globalThis.OTT_PLAYHTML_RUNTIME = runtime;
module.exports = runtime;
