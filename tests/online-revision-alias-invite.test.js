const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

function loadTsModule(relPath) {
  const fullPath = path.resolve(__dirname, relPath);
  const tsCode = fs.readFileSync(fullPath, "utf8");
  const result = esbuild.transformSync(tsCode, { loader: "ts", format: "cjs" });
  const m = { exports: {} };
  const fn = new Function("module", "exports", "require", "__dirname", "__filename", result.code);
  fn(m, m.exports, require, path.dirname(fullPath), fullPath);
  return m.exports;
}

const { Room } = require("../packages/game-core/src/room");
const { parseClientMessage } = require("../partykit/protocol");
const { parseOttMessage, normalizeAlias, generateRandomAlias } = loadTsModule("../packages/protocol/src/index.ts");
const { createSeatInvite, claimSeatInvite } = loadTsModule("../apps/worker/src/auth/internal-auth.ts");

let nextConnId = 1;
function fakeConn() {
  const inbox = [];
  return {
    id: `conn-${nextConnId++}`,
    open: true,
    inbox,
    send(text) {
      inbox.push(JSON.parse(text));
    },
  };
}

function setupRoom() {
  const room = new Room("TEST-ROOM");
  const a = fakeConn();
  const b = fakeConn();
  room.addPlayer(a, "Player A");
  room.addPlayer(b, "Player B");
  return { room, a, b };
}

describe("Online Revision Guarding & Move Deduplication", () => {
  it("executes valid move with matching expectedRevision and increments revision", () => {
    const { room, a } = setupRoom();
    assert.equal(room.revision, 2);

    const result = room.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 }, 2);
    assert.equal(result.ok, true);
    assert.equal(room.revision, 3);
  });

  it("deduplicates identical retransmitted move before stale rejection", () => {
    const { room, a } = setupRoom();
    assert.equal(room.revision, 2);

    // Initial move succeeds
    const firstResult = room.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 }, 2);
    assert.equal(firstResult.ok, true);
    assert.equal(room.revision, 3);

    // Network retry from same seat with previous expectedRevision (2) or updated (3)
    const duplicateResult = room.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 }, 2);
    assert.equal(duplicateResult.ok, true);
    assert.equal(duplicateResult.duplicate, true);
    // Revision should remain at 3
    assert.equal(room.revision, 3);
  });

  it("rejects moves with stale expectedRevision when not a duplicate", () => {
    const { room, a, b } = setupRoom();
    assert.equal(room.revision, 2);

    // First player makes valid move
    const firstResult = room.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 }, 2);
    assert.equal(firstResult.ok, true);
    assert.equal(room.revision, 3);

    // Player B sends move with stale expectedRevision 2 (instead of current 3)
    const staleResult = room.handleMove(b, { x: 4, y: 1 }, { x: 4, y: 0 }, 2);
    assert.equal(staleResult.ok, false);
    assert.equal(staleResult.error, "stale_revision");
    assert.equal(staleResult.currentRevision, 3);
    assert.equal(staleResult.expectedRevision, 2);
    // State remains unchanged
    assert.equal(room.revision, 3);
  });

  it("preserves backward compatibility for legacy clients omitting expectedRevision", () => {
    const { room, a } = setupRoom();
    assert.equal(room.revision, 2);

    // Legacy call without expectedRevision
    const result = room.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 });
    assert.equal(result.ok, true);
    assert.equal(room.revision, 3);
  });
});

describe("PartyKit and Protocol Parsing with expectedRevision", () => {
  it("accepts legacy move command without expectedRevision", () => {
    const raw = JSON.stringify({
      type: "ott:move",
      from: { x: 4, y: 7 },
      to: { x: 4, y: 6 },
    });
    const parsedPartyKit = parseClientMessage(raw);
    assert.equal(parsedPartyKit.ok, true);
    assert.equal(parsedPartyKit.value.type, "ott:move");
    assert.equal(parsedPartyKit.value.expectedRevision, undefined);

    const parsedProtocol = parseOttMessage(
      JSON.stringify({
        __ott: true,
        roomId: "ott-room-1",
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
      })
    );
    assert.equal(parsedProtocol.ok, true);
    assert.equal(parsedProtocol.value.type, "ott:move");
    assert.equal(parsedProtocol.value.expectedRevision, undefined);
  });

  it("accepts move command with non-negative integer expectedRevision", () => {
    const raw = JSON.stringify({
      type: "ott:move",
      from: { x: 4, y: 7 },
      to: { x: 4, y: 6 },
      expectedRevision: 12,
    });
    const parsedPartyKit = parseClientMessage(raw);
    assert.equal(parsedPartyKit.ok, true);
    assert.equal(parsedPartyKit.value.type, "ott:move");
    assert.equal(parsedPartyKit.value.expectedRevision, 12);

    const parsedProtocol = parseOttMessage(
      JSON.stringify({
        __ott: true,
        roomId: "ott-room-1",
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
        expectedRevision: 12,
      })
    );
    assert.equal(parsedProtocol.ok, true);
    assert.equal(parsedProtocol.value.type, "ott:move");
    assert.equal(parsedProtocol.value.expectedRevision, 12);
  });

  it("rejects move command with invalid expectedRevision or extraneous properties", () => {
    // Negative integer
    const negResult = parseClientMessage(
      JSON.stringify({
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
        expectedRevision: -1,
      })
    );
    assert.equal(negResult.ok, false);

    // Non-integer float
    const floatResult = parseClientMessage(
      JSON.stringify({
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
        expectedRevision: 1.5,
      })
    );
    assert.equal(floatResult.ok, false);

    // Extraneous property
    const extraResult = parseClientMessage(
      JSON.stringify({
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
        expectedRevision: 0,
        extra: true,
      })
    );
    assert.equal(extraResult.ok, false);

    const protocolResult = parseOttMessage(
      JSON.stringify({
        __ott: true,
        roomId: "ott-room-1",
        type: "ott:move",
        from: { x: 4, y: 7 },
        to: { x: 4, y: 6 },
        expectedRevision: -1,
      })
    );
    assert.equal(protocolResult.ok, false);
  });
});

describe("Lobby Room Aliases & Seat-Specific Invite Credentials", () => {
  it("normalizes Crockford Base32 aliases safely", () => {
    assert.equal(normalizeAlias("  k7n-m4p  "), "K7N-M4P");
    assert.equal(normalizeAlias("K7NM4P"), "K7N-M4P");
    assert.equal(normalizeAlias("w9x-2y4"), "W9X-2Y4");
    // Invalid characters or length: 5 characters like fox-42 must be rejected
    assert.equal(normalizeAlias("fox-42"), null);
    assert.equal(normalizeAlias("inv_12345"), null);
    assert.equal(normalizeAlias(""), null);
    assert.equal(normalizeAlias("TOO-LONG-ALIAS-123"), null);
  });

  it("generates 6-character hyphenated Crockford Base32 aliases", () => {
    for (let i = 0; i < 20; i++) {
      const alias = generateRandomAlias();
      assert.match(alias, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}$/);
      assert.equal(normalizeAlias(alias), alias);
    }
  });

  it("creates, claims, and enforces single-use seat-specific invites with HMAC tickets", async () => {
    const memory = new Map();
    const fakeStorage = {
      async get(key) {
        return memory.get(key);
      },
      async put(key, val) {
        memory.set(key, val);
      },
      async delete(key) {
        memory.delete(key);
      },
    };

    const secret = "test-internal-secret-for-hmac";

    // Create an invite for Seat B
    const invite = await createSeatInvite(fakeStorage, {
      allocationId: "alloc-test-1",
      roomId: "ott-alloc-test-1",
      seat: "B",
      inviteeName: "Player Two",
    });

    assert.ok(invite.inviteToken.startsWith("inv_"));
    assert.equal(invite.seat, "B");
    assert.equal(invite.allocationId, "alloc-test-1");
    assert.ok(invite.expiresAt > Date.now());

    // Claim invite
    const claimResult = await claimSeatInvite(fakeStorage, secret, {
      inviteToken: invite.inviteToken,
      playerName: "Player Two",
    });

    assert.equal(claimResult.ok, true);
    assert.equal(claimResult.allocationId, "alloc-test-1");
    assert.equal(claimResult.roomId, "ott-alloc-test-1");
    assert.equal(claimResult.seat, "B");
    assert.ok(claimResult.ticket);
    assert.ok(claimResult.resumeCredential);

    // Second claim fails (single use)
    const secondClaim = await claimSeatInvite(fakeStorage, secret, {
      inviteToken: invite.inviteToken,
      playerName: "Impostor",
    });

    assert.equal(secondClaim.ok, false);
    assert.equal(secondClaim.error, "invite_already_claimed");

    // Invalid token fails
    const invalidClaim = await claimSeatInvite(fakeStorage, secret, {
      inviteToken: "inv_nonexistent",
      playerName: "Player",
    });
    assert.equal(invalidClaim.ok, false);
    assert.equal(invalidClaim.error, "invite_not_found");
  });
});

describe("Human Tournament Worker Coordinator End-to-End Authority Flow", () => {
  let OttLobbyServerClass;

  async function getLobbyServerClass() {
    if (!OttLobbyServerClass) {
      const Module = require("node:module");
      const { build } = require("esbuild");
      const res = await build({
        entryPoints: [path.resolve(__dirname, "../apps/worker/src/lobby/ott-lobby-server.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        plugins: [
          {
            name: "cf-workers",
            setup(b) {
              b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cf", namespace: "cf" }));
              b.onLoad({ filter: /.*/, namespace: "cf" }, () => ({ contents: "export class DurableObject {}", loader: "js" }));
            },
          },
        ],
      });
      const m = new Module("ott-lobby-server-test.cjs");
      m._compile(res.outputFiles[0].text, "ott-lobby-server-test.cjs");
      OttLobbyServerClass = m.exports.OttLobbyServer;
    }
    return OttLobbyServerClass;
  }

  function createLobbyServer(storageMap, gameServerMock) {
    const storage = {
      async get(k) { return storageMap.get(k); },
      async put(k, v) { storageMap.set(k, v); },
      async delete(k) { storageMap.delete(k); },
      async list(options = {}) {
        const result = new Map();
        const prefix = options.prefix || "";
        for (const [k, v] of storageMap.entries()) {
          if (k.startsWith(prefix)) {
            result.set(k, v);
          }
        }
        return result;
      },
      async transaction(fn) { return fn(storage); },
    };
    const server = Object.create(OttLobbyServerClass.prototype);
    server.ctx = { storage, waitUntil() {} };
    server.env = {
      OTT_INTERNAL_SECRET: "internal-tournament-secret",
      OTT_SPECTATOR_ENABLED: "false",
      Main: {
        idFromName(name) { return name; },
        get(id) {
          return {
            async fetch(request) {
              if (gameServerMock) return gameServerMock(request);
              return new Response(JSON.stringify({ ok: true, room: id }), { status: 200, headers: { "content-type": "application/json" } });
            },
          };
        },
      },
    };
    return { server, storage };
  }

  it("orchestrates authentic tournament lifecycle, enforces DO terminal outcomes, and prevents organizer fabrication", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const clientIp = `client-${clientCounter++}`;
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": clientIp,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create tournament
    const createRes = await post("/control/tournament-create", {
      name: "Grand Championship",
      organizerName: "Director Bob",
      formatId: "swiss",
      mapId: "classic",
      requestedRounds: 1,
    });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.data.ok, true);
    assert.ok(createRes.data.tournamentId.startsWith("tourn-"));
    assert.ok(createRes.data.organizerSecret.startsWith("org_sec_"));
    const tournamentId = createRes.data.tournamentId;
    const organizerSecret = createRes.data.organizerSecret;

    // 2. Register participants
    const regAlice = await post("/control/tournament-register", {
      tournamentId,
      name: "Alice",
    });
    assert.equal(regAlice.status, 200);
    assert.equal(regAlice.data.ok, true);
    assert.ok(regAlice.data.participantId.startsWith("p_"));
    assert.ok(regAlice.data.participantSecret.startsWith("p_sec_"));
    const aliceId = regAlice.data.participantId;
    const aliceSecret = regAlice.data.participantSecret;

    const regCharlie = await post("/control/tournament-register", {
      tournamentId,
      name: "Charlie",
    });
    assert.equal(regCharlie.status, 200);
    assert.equal(regCharlie.data.ok, true);
    assert.ok(regCharlie.data.participantId.startsWith("p_"));
    assert.ok(regCharlie.data.participantSecret.startsWith("p_sec_"));
    const charlieId = regCharlie.data.participantId;
    const charlieSecret = regCharlie.data.participantSecret;

    // 3. Start tournament (requires valid organizerSecret)
    const unauthorizedStart = await post("/control/tournament-start", {
      tournamentId,
      organizerSecret: "invalid_secret",
    });
    assert.equal(unauthorizedStart.status, 401);

    const startRes = await post("/control/tournament-start", {
      tournamentId,
      organizerSecret,
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.data.ok, true);
    assert.equal(startRes.data.status, "in_progress");
    assert.equal(startRes.data.currentRoundNumber, 1);

    // 4. Inspect public summary (secrets must NEVER leak)
    const publicGet = await post("/control/tournament-get", { tournamentId });
    assert.equal(publicGet.status, 200);
    assert.equal(publicGet.data.ok, true);
    const tournamentView = publicGet.data.tournament;
    assert.equal(tournamentView.tournamentId, tournamentId);
    assert.equal(tournamentView.status, "in_progress");
    assert.equal(tournamentView.currentRoundMatches.length, 1);
    const roundMatch = tournamentView.currentRoundMatches[0];
    assert.ok(roundMatch.matchId);
    assert.ok(roundMatch.allocationId);
    assert.match(roundMatch.alias, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}$/);
    assert.equal(roundMatch.status, "scheduled");
    assert.equal(publicGet.data.tournament.organizerSecret, undefined);
    assert.equal(roundMatch.seatAInviteToken, undefined);
    assert.equal(roundMatch.seatBInviteToken, undefined);

    // 5. Participant Match Access (requires valid participantSecret)
    const badAccess = await post("/control/tournament-access", {
      tournamentId,
      matchId: roundMatch.matchId,
      participantId: aliceId,
      participantSecret: "wrong_secret",
    });
    assert.equal(badAccess.status, 403);

    const aliceAccess = await post("/control/tournament-access", {
      tournamentId,
      matchId: roundMatch.matchId,
      participantId: aliceId,
      participantSecret: aliceSecret,
    });
    assert.equal(aliceAccess.status, 200);
    assert.equal(aliceAccess.data.ok, true);
    assert.ok(aliceAccess.data.inviteToken.startsWith("inv_"));
    assert.equal(aliceAccess.data.alias, roundMatch.alias);
    assert.equal(aliceAccess.data.allocationId, roundMatch.allocationId);
    assert.ok(aliceAccess.data.seat === "A" || aliceAccess.data.seat === "B");

    // 6. Premature sync before terminal outcome is rejected
    const earlySync = await post("/control/tournament-sync-match", {
      tournamentId,
      matchId: roundMatch.matchId,
    });
    assert.equal(earlySync.status, 409);
    assert.equal(earlySync.data.error, "match_not_completed");

    // 7. Authoritative DO terminalization (direct from Worker Game DO with internal secret)
    const terminalizeRes = await post(
      "/internal/terminalize",
      {
        allocationId: roundMatch.allocationId,
        roomId: `ott-${roundMatch.allocationId}`,
        reason: "goal",
        winner: "A",
      },
      { "x-ott-internal-secret": "internal-tournament-secret" }
    );
    assert.equal(terminalizeRes.status, 200);
    assert.equal(terminalizeRes.data.ok, true);

    // 8. Authoritative Sync derived from storage outcome (cannot be fabricated by organizer)
    const syncRes = await post("/control/tournament-sync-match", {
      tournamentId,
      matchId: roundMatch.matchId,
    });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.data.ok, true);
    assert.equal(syncRes.data.match.status, "completed");
    assert.equal(syncRes.data.match.result, "win_a");
    assert.equal(syncRes.data.match.winnerParticipantId, roundMatch.participantA.id);
    assert.equal(syncRes.data.canAdvance, true);

    // 9. Advance round and complete tournament
    const advanceRes = await post("/control/tournament-advance", {
      tournamentId,
      organizerSecret,
    });
    assert.equal(advanceRes.status, 200);
    assert.equal(advanceRes.data.ok, true);
    assert.equal(advanceRes.data.tournamentCompleted, true);

    // 10. Verify final completed state and standings
    const finalGet = await post("/control/tournament-get", { tournamentId });
    assert.equal(finalGet.status, 200);
    assert.equal(finalGet.data.tournament.status, "completed");
    assert.ok(finalGet.data.tournament.completedAt > 0);
    const standings = finalGet.data.tournament.standings;
    assert.equal(standings.length, 2);
    assert.equal(standings[0].participantId, roundMatch.participantA.id);
    assert.equal(standings[0].points, 1);
    assert.equal(standings[0].wins, 1);
    assert.equal(standings[1].points, 0);
    assert.equal(standings[1].losses, 1);
  });

  it("strictly rejects non-classic map configuration with 400 unsupported_map", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server } = createLobbyServer(storageMap);

    let clientCounter = 100;
    const post = async (pathUrl, body) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": `client-${clientCounter++}` },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    const res = await post("/control/tournament-create", {
      name: "Custom Map Cup",
      organizerName: "Admin",
      formatId: "swiss",
      mapId: "neon",
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, "unsupported_map");
  });

  it("rolls back on game initialization failure, preventing fake success, and supports idempotent provisioning retry", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    let shouldFailInit = true;

    const gameServerMock = async (request) => {
      if (shouldFailInit && request.url.includes("/internal/initialize")) {
        return new Response(JSON.stringify({ error: "transient_game_init_error" }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { server } = createLobbyServer(storageMap, gameServerMock);

    let clientCounter = 200;
    const post = async (pathUrl, body) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": `client-${clientCounter++}` },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    const createRes = await post("/control/tournament-create", {
      name: "Resilience Cup",
      organizerName: "Admin",
      formatId: "swiss",
      mapId: "classic",
    });
    const tournamentId = createRes.data.tournamentId;
    const organizerSecret = createRes.data.organizerSecret;

    await post("/control/tournament-register", { tournamentId, name: "Alice" });
    await post("/control/tournament-register", { tournamentId, name: "Bob" });

    // 1. Initial attempt fails because game server returns 500
    const failStart = await post("/control/tournament-start", { tournamentId, organizerSecret });
    assert.equal(failStart.status, 503);
    assert.equal(failStart.data.error, "authority_unavailable");

    // Verify no fake ready rooms or lingering allocations were left behind
    for (const key of storageMap.keys()) {
      assert.ok(!key.startsWith("allocation:"), `Expected no lingering allocation, found ${key}`);
      assert.ok(!key.startsWith("alias:"), `Expected no lingering alias, found ${key}`);
      assert.ok(!key.startsWith("seat-invite:"), `Expected no lingering seat-invite, found ${key}`);
    }

    // Inspect tournament state: round matches exist but have NO allocationId assigned (no fake success)
    const midGet = await post("/control/tournament-get", { tournamentId });
    assert.equal(midGet.status, 200);
    const midMatch = midGet.data.tournament.currentRoundMatches[0];
    assert.equal(midMatch.allocationId ?? null, null);
    assert.equal(midMatch.alias ?? null, null);

    // 2. Game server recovers, retry tournament-start idempotently
    shouldFailInit = false;
    const retryStart = await post("/control/tournament-start", { tournamentId, organizerSecret });
    assert.equal(retryStart.status, 200);
    assert.equal(retryStart.data.ok, true);
    assert.equal(retryStart.data.status, "in_progress");

    // Match is now authentically provisioned
    const finalGet = await post("/control/tournament-get", { tournamentId });
    const match = finalGet.data.tournament.currentRoundMatches[0];
    assert.ok(match.allocationId);
    assert.ok(match.alias);
  });

  it("denies outsider public alias join and invite creation on tournament rooms, and supports dual seat attachment via claim-invite", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const seatUpdates = [];

    const gameServerMock = async (request) => {
      if (request.url.includes("/internal/seat-update")) {
        const body = await request.json();
        seatUpdates.push(body);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { server } = createLobbyServer(storageMap, gameServerMock);

    let clientCounter = 300;
    const post = async (pathUrl, body) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": `client-${clientCounter++}` },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    const createRes = await post("/control/tournament-create", {
      name: "Security Cup",
      organizerName: "Admin",
      formatId: "swiss",
      mapId: "classic",
    });
    const tournamentId = createRes.data.tournamentId;
    const organizerSecret = createRes.data.organizerSecret;

    const regA = await post("/control/tournament-register", { tournamentId, name: "Alice" });
    const regB = await post("/control/tournament-register", { tournamentId, name: "Bob" });

    await post("/control/tournament-start", { tournamentId, organizerSecret });

    const tourGet = await post("/control/tournament-get", { tournamentId });
    const roundMatch = tourGet.data.tournament.currentRoundMatches[0];

    // 1. Outsider cannot discover tournament match room via public /control/list
    const listRes = await post("/control/list", {});
    assert.equal(listRes.status, 200);
    assert.ok(!listRes.data.rooms.some((r) => r.id === roundMatch.allocationId || r.alias === roundMatch.alias));

    // 2. Outsider cannot join tournament room via public alias
    const joinAliasRes = await post("/control/join", {
      alias: roundMatch.alias,
      allocationId: roundMatch.alias,
      name: "OutsiderCharlie",
    });
    assert.equal(joinAliasRes.status, 409);
    assert.equal(joinAliasRes.data.error, "not_available");

    // 3. Outsider cannot create invite for tournament room
    const createInviteRes = await post("/control/create-invite", {
      allocationId: roundMatch.alias,
      seat: "B",
    });
    assert.equal(createInviteRes.status, 403);
    assert.equal(createInviteRes.data.error, "tournament_room_reserved");

    // 4. Legitimate participant match access
    const isAliceA = roundMatch.participantA.id === regA.data.participantId;

    const accessA = await post("/control/tournament-access", {
      tournamentId,
      matchId: roundMatch.matchId,
      participantId: regA.data.participantId,
      participantSecret: regA.data.participantSecret,
    });
    assert.equal(accessA.status, 200);
    assert.equal(accessA.data.seat, isAliceA ? "A" : "B");

    const accessB = await post("/control/tournament-access", {
      tournamentId,
      matchId: roundMatch.matchId,
      participantId: regB.data.participantId,
      participantSecret: regB.data.participantSecret,
    });
    assert.equal(accessB.status, 200);
    assert.equal(accessB.data.seat, isAliceA ? "B" : "A");

    // 5. Dual Seat Attachment via /control/claim-invite
    // Seat A attaches via ticket
    const claimA = await post("/control/claim-invite", {
      inviteToken: accessA.data.inviteToken,
      name: "Alice",
    });
    assert.equal(claimA.status, 200);
    assert.equal(claimA.data.seat, isAliceA ? "A" : "B");
    assert.ok(claimA.data.ticket);
    assert.ok(claimA.data.resumeCredential);

    // Seat B attaches via ticket and triggers /internal/seat-update
    const claimB = await post("/control/claim-invite", {
      inviteToken: accessB.data.inviteToken,
      name: "Bob",
    });
    assert.equal(claimB.status, 200);
    assert.equal(claimB.data.seat, isAliceA ? "B" : "A");
    assert.ok(claimB.data.ticket);
    assert.ok(claimB.data.resumeCredential);
    assert.equal(seatUpdates.length, 1);
    assert.equal(seatUpdates[0].name, isAliceA ? "Bob" : "Alice");
  });
  it("lets a player join with the room id shown in game (ott-<uuid>) or the alias, and returns the alias on join and resume", async () => {
    await getLobbyServerClass();
    const { server } = createLobbyServer(new Map());
    let clientCounter = 1;
    const post = async (action, body) => {
      const response = await server.fetch(new Request(`https://ott.local/control/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": `room-code-${clientCounter++}` },
        body: JSON.stringify(body),
      }));
      return { status: response.status, data: await response.json() };
    };

    const created = await post("create", { name: "Alice" });
    assert.equal(created.status, 200);
    assert.match(created.data.alias, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}$/);

    const joined = await post("join", { name: "Bob", allocationId: created.data.room });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.allocationId, created.data.allocationId);
    assert.equal(joined.data.seat, "B");
    assert.equal(joined.data.alias, created.data.alias);

    const resumed = await post("resume", { allocationId: created.data.room, resumeCredential: created.data.resumeCredential });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    assert.equal(resumed.data.seat, "A");
    assert.equal(resumed.data.alias, created.data.alias);

    const second = await post("create", { name: "Carol" });
    const byAlias = await post("join", { name: "Dan", allocationId: second.data.alias.toLowerCase() });
    assert.equal(byAlias.status, 200, JSON.stringify(byAlias.data));
    assert.equal(byAlias.data.allocationId, second.data.allocationId);
  });
});
