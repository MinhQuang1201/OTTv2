const { before, describe, it } = require("node:test");
const assert = require("node:assert/strict");

let createCurrentRulesetSnapshot;
let canonicalSerialize;
let canonicalRulesetJson;
let validateRulesetSnapshot;
let isSupportedEngineRuleset;
let RULESET_ID_G_V1;

let computeRulesetHash;
let computeMatchPolicyHash;
let verifyRulesetHash;
let verifyMatchPolicyHash;
let computeEngineFingerprint;
let computeCurrentEngineFingerprint;

let createNodeEngine;
let DEFAULT_MATCH_POLICY;
let MATCH_POLICY_VERSION;

const coreConfig = require("../packages/game-core/src/config");

before(async () => {
  const ruleset = await import("../packages/arena/src/domain/ruleset.mjs");
  const identity = await import("../packages/arena-node/src/core/ruleset-identity.mjs");
  const engine = await import("../packages/arena-node/src/core/node-engine.mjs");
  const policy = await import("../packages/arena/src/domain/match-policy.mjs");

  createCurrentRulesetSnapshot = ruleset.createCurrentRulesetSnapshot;
  canonicalSerialize = ruleset.canonicalSerialize;
  canonicalRulesetJson = ruleset.canonicalRulesetJson;
  validateRulesetSnapshot = ruleset.validateRulesetSnapshot;
  isSupportedEngineRuleset = ruleset.isSupportedEngineRuleset;
  RULESET_ID_G_V1 = ruleset.RULESET_ID_G_V1;

  computeRulesetHash = identity.computeRulesetHash;
  computeMatchPolicyHash = identity.computeMatchPolicyHash;
  verifyRulesetHash = identity.verifyRulesetHash;
  verifyMatchPolicyHash = identity.verifyMatchPolicyHash;
  computeEngineFingerprint = identity.computeEngineFingerprint;
  computeCurrentEngineFingerprint = identity.computeCurrentEngineFingerprint;

  createNodeEngine = engine.createNodeEngine;
  DEFAULT_MATCH_POLICY = policy.DEFAULT_MATCH_POLICY;
  MATCH_POLICY_VERSION = policy.MATCH_POLICY_VERSION;
});

describe("ruleset snapshot & canonical identity", () => {

  it("creates current ruleset snapshot matching config G", () => {
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    assert.equal(snapshot.rulesetId, RULESET_ID_G_V1);
    assert.equal(snapshot.boardWidth, 9);
    assert.equal(snapshot.boardHeight, 9);
    assert.equal(snapshot.files, "abcdefghi");
    assert.equal(snapshot.initialSetup.A.length, 10);
    assert.equal(snapshot.initialSetup.B.length, 10);
    assert.deepEqual(snapshot.goals.A, { x: 0, y: 0 });
    assert.deepEqual(snapshot.goals.B, { x: 8, y: 8 });

    const val = validateRulesetSnapshot(snapshot);
    assert.equal(val.ok, true);
    assert.equal(isSupportedEngineRuleset(snapshot), true);
  });

  it("produces identical canonical serialization and hash regardless of key insertion order", () => {
    const snapshot1 = createCurrentRulesetSnapshot(coreConfig);
    // Construct snapshot2 with shuffled keys
    const snapshot2 = {
      winConditions: [...snapshot1.winConditions],
      boardHeight: snapshot1.boardHeight,
      rulesetId: snapshot1.rulesetId,
      boardWidth: snapshot1.boardWidth,
      movement: {
        maxDistance: snapshot1.movement.maxDistance,
        deltas: [...snapshot1.movement.deltas]
      },
      goals: {
        B: { y: snapshot1.goals.B.y, x: snapshot1.goals.B.x },
        A: { y: snapshot1.goals.A.y, x: snapshot1.goals.A.x }
      },
      initialSetup: {
        B: snapshot1.initialSetup.B.map((p) => ({ y: p.y, x: p.x, type: p.type })),
        A: snapshot1.initialSetup.A.map((p) => ({ y: p.y, type: p.type, x: p.x }))
      },
      beats: { ...snapshot1.beats },
      types: [...snapshot1.types],
      files: snapshot1.files
    };

    const json1 = canonicalRulesetJson(snapshot1);
    const json2 = canonicalRulesetJson(snapshot2);
    assert.equal(json1, json2);

    const hash1 = computeRulesetHash(snapshot1);
    const hash2 = computeRulesetHash(snapshot2);
    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith("sha256:"));
  });

  it("changes hash when setup or rulesetId changes", () => {
    const snapshot1 = createCurrentRulesetSnapshot(coreConfig);
    const snapshotModSetup = createCurrentRulesetSnapshot(coreConfig);
    snapshotModSetup.initialSetup.A[0].x = 0; // mutate position

    const snapshotModId = createCurrentRulesetSnapshot(coreConfig);
    snapshotModId.rulesetId = "ottv2-custom-v1";

    const hash1 = computeRulesetHash(snapshot1);
    const hashModSetup = computeRulesetHash(snapshotModSetup);
    const hashModId = computeRulesetHash(snapshotModId);

    assert.notEqual(hash1, hashModSetup);
    assert.notEqual(hash1, hashModId);
    assert.notEqual(hashModSetup, hashModId);
  });

  it("rejects unsupported board shapes in structural validator", () => {
    const badShape1 = createCurrentRulesetSnapshot(coreConfig);
    badShape1.boardWidth = 11;
    badShape1.boardHeight = 11;
    badShape1.files = "abcdefghijk";
    const res1 = validateRulesetSnapshot(badShape1);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "unsupported_board_dimensions"));

    const badShape2 = createCurrentRulesetSnapshot(coreConfig);
    badShape2.boardWidth = 7;
    assert.equal(validateRulesetSnapshot(badShape2).ok, false);
  });

  it("strictly rejects modified G semantics in isSupportedEngineRuleset", () => {
    // 1. Changed beats
    const modBeats = createCurrentRulesetSnapshot(coreConfig);
    modBeats.beats = { dam: "la", la: "keo", keo: "dam" }; // inverted
    assert.equal(isSupportedEngineRuleset(modBeats), false);

    // 2. Changed deltas
    const modDeltas = createCurrentRulesetSnapshot(coreConfig);
    modDeltas.movement.deltas = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // rook-only moves
    assert.equal(isSupportedEngineRuleset(modDeltas), false);

    // 3. Changed maxDistance
    const modDist = createCurrentRulesetSnapshot(coreConfig);
    modDist.movement.maxDistance = 2;
    assert.equal(isSupportedEngineRuleset(modDist), false);

    // 4. Changed setup coordinates
    const modCoord = createCurrentRulesetSnapshot(coreConfig);
    modCoord.initialSetup.A[0].x = 3; // changed from 4
    assert.equal(isSupportedEngineRuleset(modCoord), false);

    // 5. Changed piece type in setup
    const modType = createCurrentRulesetSnapshot(coreConfig);
    modType.initialSetup.A[0].type = "dam"; // changed from la
    assert.equal(isSupportedEngineRuleset(modType), false);

    // 6. Broken mirror in seat B
    const modMirror = createCurrentRulesetSnapshot(coreConfig);
    modMirror.initialSetup.B[0].x = 0; // broken rotation
    assert.equal(isSupportedEngineRuleset(modMirror), false);

    // 7. Duplicate types
    const dupTypes = createCurrentRulesetSnapshot(coreConfig);
    dupTypes.types = ["dam", "la", "dam"];
    assert.equal(isSupportedEngineRuleset(dupTypes), false);
    assert.equal(validateRulesetSnapshot(dupTypes).ok, false);

    // 8. Changed goals
    const modGoal = createCurrentRulesetSnapshot(coreConfig);
    modGoal.goals.A = { x: 1, y: 1 };
    assert.equal(isSupportedEngineRuleset(modGoal), false);

    // 9. Changed win conditions
    const modWin = createCurrentRulesetSnapshot(coreConfig);
    modWin.winConditions = ["goal"];
    assert.equal(isSupportedEngineRuleset(modWin), false);
  });

  it("safely rejects malformed/malicious nested snapshot schemas without throwing", () => {
    const malformedCases = [
      null,
      undefined,
      [],
      "string-not-object",
      12345,
      {},
      { rulesetId: "test", boardWidth: "9" },
      { rulesetId: "test", boardWidth: 9, boardHeight: 9, files: "abcdefghi", types: null },
      { rulesetId: "test", boardWidth: 9, boardHeight: 9, files: "abcdefghi", types: ["dam"], beats: [] },
      {
        rulesetId: "test",
        boardWidth: 9,
        boardHeight: 9,
        files: "abcdefghi",
        types: ["dam"],
        beats: {},
        goals: null
      },
      {
        rulesetId: "test",
        boardWidth: 9,
        boardHeight: 9,
        files: "abcdefghi",
        types: ["dam"],
        beats: {},
        goals: { A: { x: -1, y: 0 }, B: { x: 8, y: 8 } }
      },
      {
        rulesetId: "test",
        boardWidth: 9,
        boardHeight: 9,
        files: "abcdefghi",
        types: ["dam"],
        beats: {},
        goals: { A: { x: 0, y: 0 }, B: { x: 8, y: 8 } },
        initialSetup: { A: [null], B: [] }
      },
      {
        rulesetId: "test",
        boardWidth: 9,
        boardHeight: 9,
        files: "abcdefghi",
        types: ["dam"],
        beats: {},
        goals: { A: { x: 0, y: 0 }, B: { x: 8, y: 8 } },
        initialSetup: { A: [{ type: "dam", x: 0, y: 0 }, { type: "dam", x: 0, y: 0 }], B: [] } // duplicate cell
      },
      {
        rulesetId: "test",
        boardWidth: 9,
        boardHeight: 9,
        files: "abcdefghi",
        types: ["dam"],
        beats: {},
        goals: { A: { x: 0, y: 0 }, B: { x: 8, y: 8 } },
        initialSetup: { A: [], B: [] },
        movement: { maxDistance: 0, deltas: "bad" }
      }
    ];

    for (const bad of malformedCases) {
      assert.doesNotThrow(() => {
        const res = validateRulesetSnapshot(bad);
        assert.equal(res.ok, false);
        assert.ok(Array.isArray(res.errors));
        assert.ok(res.errors.length > 0);
      });
      assert.doesNotThrow(() => {
        const supported = isSupportedEngineRuleset(bad);
        assert.equal(supported, false);
      });
    }
  });

  it("computes core engine fingerprint from packages/game-core", () => {
    const fp1 = computeCurrentEngineFingerprint();
    assert.ok(typeof fp1 === "string");
    assert.ok(fp1.startsWith("sha256:"));
    assert.equal(fp1.length, 7 + 64); // "sha256:" + 64 hex chars

    const fpMock1 = computeEngineFingerprint("config content A", "rules content B");
    const fpMock2 = computeEngineFingerprint("config content A", "rules content C");
    assert.notEqual(fpMock1, fpMock2);
  });
});

describe("node engine port adapter", () => {
  it("creates EnginePort instance conforming to interface", () => {
    const engine = createNodeEngine();
    assert.equal(typeof engine.createInitialState, "function");
    assert.equal(typeof engine.cloneState, "function");
    assert.equal(typeof engine.allMoves, "function");
    assert.equal(typeof engine.applyMove, "function");
    assert.equal(typeof engine.detectWinner, "function");
  });

  it("initial state has turn A and 20 total pieces", () => {
    const engine = createNodeEngine();
    const state = engine.createInitialState();
    assert.equal(state.turn, "A");
    assert.equal(state.pieces.length, 20);
    assert.equal(state.pieces.filter((p) => p.player === "A").length, 10);
    assert.equal(state.pieces.filter((p) => p.player === "B").length, 10);
  });

  it("normalizes detectWinner when game has no winner to object with nulls (not raw null)", () => {
    const engine = createNodeEngine();
    const state = engine.createInitialState();
    const result = engine.detectWinner(state);
    assert.deepEqual(result, {
      winner: null,
      reason: null,
      eliminatedPlayer: null
    });
  });

  it("generates legal moves and applies opening move correctly", () => {
    const engine = createNodeEngine();
    const state = engine.createInitialState();
    const movesA = engine.allMoves(state, "A");
    assert.ok(movesA.length > 0);

    // Legal move for A from E8 (x:4, y:7) to D7 (x:3, y:6)
    const moveRes = engine.applyMove(state, "A", { x: 4, y: 7 }, { x: 3, y: 6 });
    assert.equal(moveRes.ok, true);
    assert.equal(moveRes.state.turn, "B");
    assert.equal(moveRes.events.length, 1);
    assert.equal(moveRes.events[0].type, "move");
  });

  it("rejects illegal move gracefully without mutating state", () => {
    const engine = createNodeEngine();
    const state = engine.createInitialState();
    // Illegal jump 2 squares
    const moveRes = engine.applyMove(state, "A", { x: 4, y: 7 }, { x: 4, y: 5 });
    assert.equal(moveRes.ok, false);
    assert.ok(typeof moveRes.error === "string");
    assert.equal(moveRes.state, null);
  });
});

describe("match policy canonical identity & hash", () => {
  it("produces identical canonical serialization and hash regardless of key insertion order", () => {
    const policy1 = DEFAULT_MATCH_POLICY;
    const policy2 = {
      turnTimeLimitMs: DEFAULT_MATCH_POLICY.turnTimeLimitMs,
      clockSource: DEFAULT_MATCH_POLICY.clockSource,
      matchPolicyVersion: DEFAULT_MATCH_POLICY.matchPolicyVersion,
      clockBoundary: DEFAULT_MATCH_POLICY.clockBoundary,
      initialTimeMs: DEFAULT_MATCH_POLICY.initialTimeMs,
      maxPlies: DEFAULT_MATCH_POLICY.maxPlies
    };

    const hash1 = computeMatchPolicyHash(policy1);
    const hash2 = computeMatchPolicyHash(policy2);
    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith("sha256:"));
    assert.equal(hash1.length, 7 + 64);
    assert.equal(verifyMatchPolicyHash(policy1, hash1), true);
    assert.equal(verifyMatchPolicyHash(policy2, hash1), true);
  });

  it("changes matchPolicyHash when time policy parameters change (§Task1 step6)", () => {
    const policyDefault = DEFAULT_MATCH_POLICY;
    const policyModTurn = { ...DEFAULT_MATCH_POLICY, turnTimeLimitMs: 2000 };
    const policyModInitial = { ...DEFAULT_MATCH_POLICY, initialTimeMs: 300000 };

    const hashDefault = computeMatchPolicyHash(policyDefault);
    const hashModTurn = computeMatchPolicyHash(policyModTurn);
    const hashModInitial = computeMatchPolicyHash(policyModInitial);

    assert.notEqual(hashDefault, hashModTurn);
    assert.notEqual(hashDefault, hashModInitial);
    assert.notEqual(hashModTurn, hashModInitial);
  });

  it("does not conflate rulesetHash with matchPolicyHash", () => {
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const policyHash = computeMatchPolicyHash(DEFAULT_MATCH_POLICY);

    assert.ok(rulesetHash.startsWith("sha256:"));
    assert.ok(policyHash.startsWith("sha256:"));
    assert.notEqual(rulesetHash, policyHash);
  });
});

