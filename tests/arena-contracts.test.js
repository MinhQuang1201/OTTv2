const { before, describe, it } = require("node:test");
const assert = require("node:assert/strict");

let validateBotTurn;
let validateBotAction;
let validateArenaMatchResult;
let validateMatchPolicy;
let DEFAULT_MATCH_POLICY;
let canonicalMatchPolicyJson;

before(async () => {
  const validation = await import("../packages/arena/src/contracts/validation.mjs");
  const matchPolicy = await import("../packages/arena/src/domain/match-policy.mjs");

  validateBotTurn = validation.validateBotTurn;
  validateBotAction = validation.validateBotAction;
  validateArenaMatchResult = validation.validateArenaMatchResult;
  validateMatchPolicy = validation.validateMatchPolicy;
  DEFAULT_MATCH_POLICY = matchPolicy.DEFAULT_MATCH_POLICY;
  canonicalMatchPolicyJson = matchPolicy.canonicalMatchPolicyJson;
});

function createValidTurn() {
  return {
    protocolVersion: 1,
    type: "turn",
    requestId: "match-001:A:1",
    matchId: "match-001",
    rulesetId: "ottv2-g-default-v1",
    rulesetHash: "sha256:test-hash",
    boardWidth: 9,
    boardHeight: 9,
    ply: 1,
    turn: "A",
    timeRemainingMs: 600000,
    turnTimeLimitMs: 1000,
    board: [
      { id: "A-la-0", owner: "A", type: "la", x: 4, y: 7 },
      { id: "B-la-0", owner: "B", type: "la", x: 4, y: 1 }
    ],
    legalMoves: [
      { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
    ]
  };
}

describe("arena contracts: BotTurn validation", () => {

  it("accepts a valid protocol v1 turn payload", () => {
    const turn = createValidTurn();
    const result = validateBotTurn(turn);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("rejects non-object or null turn payload", () => {
    assert.equal(validateBotTurn(null).ok, false);
    assert.equal(validateBotTurn("invalid").ok, false);
    assert.equal(validateBotTurn(123).ok, false);
  });

  it("rejects unknown protocol version", () => {
    const turn = { ...createValidTurn(), protocolVersion: 2 };
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "invalid_protocol_version"));
  });

  it("rejects type other than turn", () => {
    const turn = { ...createValidTurn(), type: "init" };
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "invalid_message_type"));
  });

  it("rejects invalid seat", () => {
    const turn = { ...createValidTurn(), turn: "C" };
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "invalid_seat"));
  });

  it("rejects non-integer, negative or fractional coordinates in board pieces", () => {
    const turn = createValidTurn();
    turn.board[0].x = 4.5;
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "invalid_coordinate"));
  });

  it("rejects off-board coordinates (< 0 or >= boardWidth/Height)", () => {
    const turn = createValidTurn();
    turn.board[0].x = 9;
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "coordinate_out_of_bounds"));
  });

  it("rejects board with duplicate occupancy (two pieces on same cell)", () => {
    const turn = createValidTurn();
    turn.board.push({ id: "A-dam-1", owner: "A", type: "dam", x: 4, y: 7 }); // same cell as A-la-0
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "duplicate_cell_occupancy"));
  });

  it("rejects duplicate piece IDs", () => {
    const turn = createValidTurn();
    turn.board.push({ id: "A-la-0", owner: "A", type: "dam", x: 0, y: 0 }); // duplicate id
    const result = validateBotTurn(turn);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "duplicate_piece_id"));
  });

  it("rejects non-integer ply or ply <= 0", () => {
    const turn = { ...createValidTurn(), ply: 0 };
    assert.equal(validateBotTurn(turn).ok, false);
    const turn2 = { ...createValidTurn(), ply: 1.5 };
    assert.equal(validateBotTurn(turn2).ok, false);
  });

  it("rejects negative or non-finite timeRemainingMs", () => {
    const turn = { ...createValidTurn(), timeRemainingMs: -5 };
    assert.equal(validateBotTurn(turn).ok, false);
    const turn2 = { ...createValidTurn(), timeRemainingMs: Infinity };
    assert.equal(validateBotTurn(turn2).ok, false);
  });
});

describe("arena contracts: BotAction validation", () => {

  function createValidAction() {
    return {
      protocolVersion: 1,
      requestId: "match-001:A:1",
      move: {
        from: { x: 4, y: 7 },
        to: { x: 3, y: 6 }
      },
      comment: "first legal"
    };
  }

  it("accepts a valid protocol v1 bot action", () => {
    const action = createValidAction();
    const result = validateBotAction(action, "match-001:A:1");
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("rejects mismatched requestId when expectedRequestId is supplied", () => {
    const action = createValidAction();
    const result = validateBotAction(action, "match-001:A:2");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "request_id_mismatch"));
  });

  it("rejects missing move", () => {
    const action = { protocolVersion: 1, requestId: "match-001:A:1" };
    const result = validateBotAction(action);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "missing_move"));
  });

  it("rejects non-integer or fractional coordinates in move", () => {
    const action = createValidAction();
    action.move.to.x = 3.2;
    const result = validateBotAction(action);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "invalid_coordinate"));
  });

  it("rejects comments exceeding 2048 characters", () => {
    const action = createValidAction();
    action.comment = "x".repeat(2049);
    const result = validateBotAction(action);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "comment_too_long"));
  });

  it("accepts action without optional comment", () => {
    const action = {
      protocolVersion: 1,
      requestId: "match-001:A:1",
      move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
    };
    const result = validateBotAction(action, "match-001:A:1");
    assert.equal(result.ok, true);
  });
});

describe("arena contracts: ArenaMatchResult validation", () => {

  it("accepts valid win result with goal, elimination, and no_moves", () => {
    for (const reason of ["goal", "elimination", "no_moves"]) {
      const res = { outcome: "win", winner: "A", loser: "B", reason, acceptedPlies: 24 };
      assert.equal(validateArenaMatchResult(res).ok, true);
    }
  });

  it("rejects win result with identical winner and loser", () => {
    const res = { outcome: "win", winner: "A", loser: "A", reason: "goal", acceptedPlies: 24 };
    const val = validateArenaMatchResult(res);
    assert.equal(val.ok, false);
    assert.ok(val.errors.some((e) => e.code === "invalid_participants"));
  });

  it("rejects win result with invalid reason", () => {
    const res = { outcome: "win", winner: "A", loser: "B", reason: "turn_timeout", acceptedPlies: 24 };
    const val = validateArenaMatchResult(res);
    assert.equal(val.ok, false);
    assert.ok(val.errors.some((e) => e.code === "invalid_reason"));
  });

  it("accepts valid draw result with max_plies", () => {
    const res = { outcome: "draw", winner: null, loser: null, reason: "max_plies", acceptedPlies: 400 };
    assert.equal(validateArenaMatchResult(res).ok, true);
  });

  it("rejects draw result with non-null winner or loser", () => {
    const res = { outcome: "draw", winner: "A", loser: null, reason: "max_plies", acceptedPlies: 400 };
    assert.equal(validateArenaMatchResult(res).ok, false);
  });

  it("rejects draw result with reason other than max_plies", () => {
    const res = { outcome: "draw", winner: null, loser: null, reason: "stalemate", acceptedPlies: 400 };
    assert.equal(validateArenaMatchResult(res).ok, false);
  });

  it("accepts valid forfeit result with all designated reasons", () => {
    const reasons = [
      "turn_timeout",
      "total_timeout",
      "crash",
      "protocol_error",
      "illegal_move",
      "output_limit"
    ];
    for (const reason of reasons) {
      const res = { outcome: "forfeit", winner: "B", loser: "A", reason, acceptedPlies: 10 };
      assert.equal(validateArenaMatchResult(res).ok, true);
    }
  });

  it("rejects forfeit result with win reason like goal or elimination", () => {
    const res = { outcome: "forfeit", winner: "B", loser: "A", reason: "goal", acceptedPlies: 10 };
    assert.equal(validateArenaMatchResult(res).ok, false);
  });

  it("rejects negative acceptedPlies", () => {
    const res = { outcome: "draw", winner: null, loser: null, reason: "max_plies", acceptedPlies: -1 };
    assert.equal(validateArenaMatchResult(res).ok, false);
  });
});

describe("arena contracts: MatchPolicy v1", () => {

  it("exposes default policy matching policy v1 specification", () => {
    assert.equal(DEFAULT_MATCH_POLICY.matchPolicyVersion, "arena-policy-v1");
    assert.equal(DEFAULT_MATCH_POLICY.maxPlies, 400);
    assert.equal(DEFAULT_MATCH_POLICY.initialTimeMs, 600000);
    assert.equal(DEFAULT_MATCH_POLICY.turnTimeLimitMs, 1000);
    assert.equal(DEFAULT_MATCH_POLICY.clockBoundary, "strict_less_than_budget");
    assert.equal(DEFAULT_MATCH_POLICY.clockSource, "referee_monotonic");
  });

  it("validates correct policy", () => {
    assert.equal(validateMatchPolicy(DEFAULT_MATCH_POLICY).ok, true);
  });

  it("rejects unsupported matchPolicyVersion", () => {
    const bad = { ...DEFAULT_MATCH_POLICY, matchPolicyVersion: "arena-policy-v2" };
    const res = validateMatchPolicy(bad);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "unsupported_policy_version"));
  });

  it("strictly enforces maxPlies === 400 and rejects cap > 400 and cap 399 under arena-policy-v1", () => {
    // 1. Cap > 400 (e.g. 401)
    const cap401 = { ...DEFAULT_MATCH_POLICY, maxPlies: 401 };
    const res401 = validateMatchPolicy(cap401);
    assert.equal(res401.ok, false);
    assert.ok(res401.errors.some((e) => e.code === "unsupported_max_plies"));

    // 2. Cap 399
    const cap399 = { ...DEFAULT_MATCH_POLICY, maxPlies: 399 };
    const res399 = validateMatchPolicy(cap399);
    assert.equal(res399.ok, false);
    assert.ok(res399.errors.some((e) => e.code === "unsupported_max_plies"));

    // 3. Negative or zero cap
    const capZero = { ...DEFAULT_MATCH_POLICY, maxPlies: 0 };
    assert.equal(validateMatchPolicy(capZero).ok, false);
  });

  it("serializes match policy to canonical JSON with sorted keys", () => {
    const json1 = canonicalMatchPolicyJson(DEFAULT_MATCH_POLICY);
    const shuffled = {
      turnTimeLimitMs: DEFAULT_MATCH_POLICY.turnTimeLimitMs,
      clockSource: DEFAULT_MATCH_POLICY.clockSource,
      matchPolicyVersion: DEFAULT_MATCH_POLICY.matchPolicyVersion,
      clockBoundary: DEFAULT_MATCH_POLICY.clockBoundary,
      initialTimeMs: DEFAULT_MATCH_POLICY.initialTimeMs,
      maxPlies: DEFAULT_MATCH_POLICY.maxPlies
    };
    const json2 = canonicalMatchPolicyJson(shuffled);
    assert.equal(json1, json2);
    const parsed = JSON.parse(json1);
    assert.equal(parsed.matchPolicyVersion, "arena-policy-v1");
  });
});

