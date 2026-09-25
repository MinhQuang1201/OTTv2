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

  // A uses three interlocking RPS triangles in the upper-right. Each triangle
  // can answer the counter that threatens either of its other two pieces,
  // while the gaps keep opening moves from being locked into a 3x3 block.
  // B is the 180-degree rotation around e5, so both sides remain balanced.
  const A_SETUP = [
    { type: "dam", x: 6, y: 0 }, // g1
    { type: "keo", x: 7, y: 0 }, // h1
    { type: "la", x: 6, y: 1 }, // g2
    { type: "dam", x: 7, y: 2 }, // h3
    { type: "keo", x: 8, y: 2 }, // i3
    { type: "la", x: 8, y: 3 }, // i4
    { type: "dam", x: 6, y: 3 }, // g4
    { type: "keo", x: 7, y: 4 }, // h5
    { type: "la", x: 6, y: 4 } // g5
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
