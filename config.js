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

  // The a1-i9 diagonal (x === y) is the neutral divider. A deploys in three
  // independent RPS wings at least three layers away from it, so neither side
  // can reach the divider or make contact on the opening move. B is reflected
  // across the divider in rules.createInitialState.
  const A_SETUP = [
    // Cánh 1: áp sát khu vực a1 nhưng vẫn ngoài vùng trung lập.
    { type: "dam", x: 3, y: 0 }, // d1
    { type: "keo", x: 4, y: 0 }, // e1
    { type: "la", x: 4, y: 1 }, // e2
    // Cánh 2: giữ trục giữa.
    { type: "la", x: 5, y: 1 }, // f2
    { type: "dam", x: 6, y: 1 }, // g2
    { type: "keo", x: 6, y: 2 }, // g3
    // Cánh 3: gây sức ép về phía i9.
    { type: "keo", x: 7, y: 3 }, // h4
    { type: "la", x: 8, y: 3 }, // i4
    { type: "dam", x: 8, y: 4 } // i5
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
