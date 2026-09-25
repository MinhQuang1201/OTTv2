"use strict";

// Adapter contract only; this does not reimplement the PlayHTML/Yjs worker.
function createPlayhtmlBase({ upstream }) {
  if (!upstream || typeof upstream.handle !== "function") {
    throw new TypeError("PlayHTML upstream handler is required");
  }

  return {
    receive(frame, onOttFrame, onError) {
      if (typeof onOttFrame !== "function" || typeof onError !== "function") {
        throw new TypeError("OTT callbacks are required");
      }

      if (typeof frame !== "string") {
        upstream.handle(frame);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(frame);
      } catch (_) {
        upstream.handle(frame);
        return;
      }

      if (!parsed || parsed.__ott !== true) {
        upstream.handle(frame);
        return;
      }

      if (typeof parsed.type !== "string" || !parsed.type.startsWith("ott:")) {
        onError({ type: "ott:error", code: "invalid_ott" });
        return;
      }

      onOttFrame(parsed);
    }
  };
}

module.exports = { createPlayhtmlBase };
