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
  const SEAT_LABEL = { A: "Đỏ", B: "Xanh", C: "Vàng", D: "Lục" };
  // Duel goals are opposite each player's starting side.
  const GOAL = { A: { x: 8, y: 0 }, B: { x: 0, y: 8 } };
  const ARENA_GOAL = {
    A: { x: 0, y: 8 },
    B: { x: 0, y: 0 },
    C: { x: 8, y: 0 },
    D: { x: 8, y: 8 }
  };
  const MODES = {
    duel: { seats: ["A", "B"], maxPlayers: 2 },
    arena: { seats: ["A", "B", "C", "D"], maxPlayers: 4 }
  };

  const TIME_CONTROL = {
    initialMs: 10 * 60 * 1000,
    reconnectGraceMs: 60 * 1000
  };

  // Canonical Duel setup from Rule.md. B is rotated 180 degrees in
  // rules.createInitialState.
  const A_SETUP = [
    { type: "la", x: 0, y: 2 }, // a3
    { type: "dam", x: 1, y: 2 }, // b3
    { type: "keo", x: 2, y: 2 }, // c3
    { type: "dam", x: 0, y: 3 }, // a4
    { type: "keo", x: 1, y: 3 }, // b4
    { type: "la", x: 2, y: 3 }, // c4
    { type: "keo", x: 0, y: 4 }, // a5
    { type: "la", x: 1, y: 4 }, // b5
    { type: "dam", x: 2, y: 4 } // c5
  ];

  // Arena A: g–i / rank 2–3. B/C/D are 90° clockwise copies.
  const A_ARENA_SETUP = [
    { type: "la", x: 6, y: 1 },
    { type: "dam", x: 7, y: 1 },
    { type: "keo", x: 8, y: 1 },
    { type: "dam", x: 6, y: 2 },
    { type: "keo", x: 7, y: 2 },
    { type: "la", x: 8, y: 2 }
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

  const REACTS = {
    fire: "🔥",
    fight: "⚔️",
    gg: "GG",
    clap: "👏",
    lol: "😂"
  };

  return {
    SIZE,
    FILES,
    TYPES,
    BEATS,
    TYPE_LABEL,
    SEAT_LABEL,
    GOAL,
    ARENA_GOAL,
    MODES,
    A_SETUP,
    A_ARENA_SETUP,
    TIME_CONTROL,
    DELTAS,
    REACTS,
    PORT,
    HOST: "0.0.0.0",
    NAME_MAX: 20,
    ROOM_NAME_MAX: 28,
    CHAT_MAX: 120,
    CHAT_KEEP: 30,
    ROOM_ID_LEN: 4,
    MAX_ROOMS: 200,
    MAX_SPECTATORS: 100,
    MAX_MESSAGE: 8192,
    ASSET: { dam: "assets/dam.png", la: "assets/la.png", keo: "assets/keo.png" },
    ATLAS: "assets/rps-atlas.png",
    ICON_CLASS: { dam: "rps-icon-dam", la: "rps-icon-la", keo: "rps-icon-keo" }
  };
});
