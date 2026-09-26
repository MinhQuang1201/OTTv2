"use strict";

const { createPlayhtmlBase } = require("./playhtml-base");

function createPlayhtmlBridge({ upstream, onOttFrame, onError }) {
  if (typeof onOttFrame !== "function") {
    throw new TypeError("OTT frame dispatcher is required");
  }
  const base = createPlayhtmlBase({ upstream });
  const reportError = typeof onError === "function" ? onError : () => {};

  return {
    receive(frame) {
      base.receive(frame, onOttFrame, reportError);
    },
    target(frame) {
      if (!frame || typeof frame !== "object" || frame.__ott !== true) return null;
      return frame.type === "ott:create" || frame.type === "ott:list" ? "lobby" : frame.roomId ? "game" : "lobby";
    }
  };
}

module.exports = { createPlayhtmlBridge };
