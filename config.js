(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  global.OTT_CONFIG = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SIZE = 9;
  const FILES = "abcdefghi";
  const TYPES = ["dam", "la", "keo"];
  const BEATS = { dam: "keo", keo: "la", la: "dam" };
  const TYPE_LABEL = { dam: "Đấm", la: "Lá", keo: "Kéo" };
  const SEAT_LABEL = { A: "Đỏ", B: "Xanh" };
  const GOAL = { A: { x: 0, y: 8 }, B: { x: 8, y: 0 } };

  const TIME_CONTROL = {
    initialMs: 10 * 60 * 1000,
    reconnectGraceMs: 60 * 1000
  };

  // A starts in the upper-left. B is the 180-degree rotate around e5.
  const A_SETUP = [
    { type: "la", x: 0, y: 2 },
    { type: "dam", x: 1, y: 2 },
    { type: "keo", x: 2, y: 2 },
    { type: "dam", x: 0, y: 3 },
    { type: "keo", x: 1, y: 3 },
    { type: "la", x: 2, y: 3 },
    { type: "keo", x: 0, y: 4 },
    { type: "la", x: 1, y: 4 },
    { type: "dam", x: 2, y: 4 }
  ];

  const DELTAS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1]
  ];

  const PORT =
    typeof process !== "undefined" && process.env && process.env.PORT
      ? Number(process.env.PORT)
      : 3000;

  return {
    SIZE,
    FILES,
    TYPES,
    BEATS,
    TYPE_LABEL,
    SEAT_LABEL,
    GOAL,
    A_SETUP,
    TIME_CONTROL,
    DELTAS,
    PORT,
    HOST: "0.0.0.0",
    NAME_MAX: 20,
    ROOM_ID_LEN: 4,
    MAX_ROOMS: 200,
    MAX_MESSAGE: 8192,
    ASSET: { dam: "assets/dam.png", la: "assets/la.png", keo: "assets/keo.png" }
  };
});
