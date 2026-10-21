const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

let OttLobbyServerClass = null;
async function getLobbyServerClass() {
  if (!OttLobbyServerClass) {
    const res = await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../apps/worker/src/lobby/ott-lobby-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      plugins: [
        {
          name: "cf-test",
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
  let txTail = Promise.resolve();
  const storage = {
    async get(k) {
      await new Promise((r) => setImmediate(r));
      const v = storageMap.get(k);
      return v !== undefined ? structuredClone(v) : undefined;
    },
    async put(k, v) {
      storageMap.set(k, structuredClone(v));
    },
    async delete(k) { storageMap.delete(k); },
    async list(options = {}) {
      const result = new Map();
      const prefix = options.prefix || "";
      for (const [k, v] of storageMap.entries()) {
        if (k.startsWith(prefix)) {
          result.set(k, structuredClone(v));
        }
      }
      return result;
    },
    async transaction(fn) {
      const prev = txTail;
      let release;
      txTail = new Promise((r) => { release = r; });
      await prev;
      try {
        return await fn(storage);
      } finally {
        release();
      }
    },
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

describe("Online Hotfix Regression Suite", () => {
  it("Bug 1: tournament advance directly after terminalize without prior sync-match advances round", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create and register 2 participants
    const createRes = await post("/control/tournament-create", {
      name: "Direct Advance Championship",
      organizerName: "Director Dave",
      formatId: "swiss",
      mapId: "classic",
      requestedRounds: 1,
    });
    assert.equal(createRes.status, 200);
    const { tournamentId, organizerSecret } = createRes.data;

    await post("/control/tournament-register", { tournamentId, name: "Alice" });
    await post("/control/tournament-register", { tournamentId, name: "Bob" });

    // 2. Start tournament
    const startRes = await post("/control/tournament-start", { tournamentId, organizerSecret });
    assert.equal(startRes.status, 200);

    const getRes = await post("/control/tournament-get", { tournamentId });
    const match = getRes.data.tournament.currentRoundMatches[0];
    assert.ok(match.allocationId);

    // 3. Game finishes on Game DO and writes terminal outcome
    const termRes = await post("/internal/terminalize", {
      allocationId: match.allocationId,
      roomId: `ott-${match.allocationId}`,
      reason: "goal",
      winner: "A",
    }, { "x-ott-internal-secret": "internal-tournament-secret" });
    assert.equal(termRes.status, 200);

    // 4. Directly call tournament-advance WITHOUT calling tournament-sync-match or tournament-get first
    const advanceRes = await post("/control/tournament-advance", {
      tournamentId,
      organizerSecret,
    });

    // BUG 1: If currentTournament is unsaved, advanceRes.status will be 409 round_matches_incomplete
    assert.equal(advanceRes.status, 200, `Expected 200 but got ${advanceRes.status}: ${JSON.stringify(advanceRes.data)}`);
    assert.equal(advanceRes.data.ok, true);
    assert.equal(advanceRes.data.tournamentCompleted, true);
  });

  it("Bug 2: concurrent sync-match requests do not lose updates", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server, storage } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create and register 4 participants (2 matches in round 1)
    const createRes = await post("/control/tournament-create", {
      name: "Concurrent Sync Cup",
      organizerName: "Director Dan",
      formatId: "swiss",
      mapId: "classic",
      requestedRounds: 1,
    });
    assert.equal(createRes.status, 200);
    const { tournamentId, organizerSecret } = createRes.data;

    await post("/control/tournament-register", { tournamentId, name: "P1" });
    await post("/control/tournament-register", { tournamentId, name: "P2" });
    await post("/control/tournament-register", { tournamentId, name: "P3" });
    await post("/control/tournament-register", { tournamentId, name: "P4" });

    // 2. Start tournament
    const startRes = await post("/control/tournament-start", { tournamentId, organizerSecret });
    assert.equal(startRes.status, 200);

    const getRes = await post("/control/tournament-get", { tournamentId });
    const matches = getRes.data.tournament.currentRoundMatches;
    assert.equal(matches.length, 2);

    // 3. Both matches finish
    await post("/internal/terminalize", {
      allocationId: matches[0].allocationId,
      roomId: `ott-${matches[0].allocationId}`,
      reason: "goal",
      winner: "A",
    }, { "x-ott-internal-secret": "internal-tournament-secret" });

    await post("/internal/terminalize", {
      allocationId: matches[1].allocationId,
      roomId: `ott-${matches[1].allocationId}`,
      reason: "goal",
      winner: "B",
    }, { "x-ott-internal-secret": "internal-tournament-secret" });

    // 4. Concurrent sync of both matches via Promise.all
    const [sync1, sync2] = await Promise.all([
      post("/control/tournament-sync-match", { tournamentId, matchId: matches[0].matchId }),
      post("/control/tournament-sync-match", { tournamentId, matchId: matches[1].matchId }),
    ]);

    assert.equal(sync1.status, 200);
    assert.equal(sync2.status, 200);

    // 5. Verify storage directly has BOTH matches completed (no lost update)
    const directTournament = await storage.get(`tournament:${tournamentId}`);
    const directMatches = directTournament.rounds[0].matches;
    assert.equal(directMatches[0].status, "completed", "Match 0 in storage should be completed");
    assert.equal(directMatches[1].status, "completed", "Match 1 in storage should be completed");
  });

  it("Bug 3: concurrent claim-invite on single-use token permits exactly one claimant", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create a public waiting room
    const createRes = await post("/control/create", { name: "Host Player" });
    assert.equal(createRes.status, 200);
    const { allocationId, resumeCredential } = createRes.data;

    // 2. Create seat-specific invite for seat B
    const inviteRes = await post("/control/create-invite", {
      allocationId,
      seat: "B",
      inviteeName: "Guest",
      ownerCredential: resumeCredential,
    });
    assert.equal(inviteRes.status, 200);
    const { inviteToken } = inviteRes.data;

    // 3. Two concurrent claims for the same inviteToken
    const [claim1, claim2] = await Promise.all([
      post("/control/claim-invite", { inviteToken, name: "Claimant 1" }),
      post("/control/claim-invite", { inviteToken, name: "Claimant 2" }),
    ]);

    const statuses = [claim1.status, claim2.status].sort();
    assert.deepEqual(statuses, [200, 400], "Exactly one claim should succeed (200) and one should be rejected (400)");

    const failed = claim1.status === 400 ? claim1 : claim2;
    assert.equal(failed.data.error, "invite_already_claimed");
  });

  it("Bug 4: allocateAlias fallback never overwrites existing alias record", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server, storage } = createLobbyServer(storageMap);

    // Pre-populate an existing alias record matching the exact fallback
    const targetAllocationId = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
    // Derived hash from allocationId: F8D-4FA
    const derivedFallback = "F8D-4FA";
    await storage.put(`alias:${derivedFallback}`, {
      allocationId: "pre-existing-allocation",
      roomId: "ott-pre-existing-allocation",
      createdAt: 1000,
    });

    // Force random alias candidates 0..9 to collide
    let randomAttemptCount = 0;
    const origGet = storage.get.bind(storage);
    storage.get = async (k) => {
      if (k.startsWith("alias:") && k !== `alias:${derivedFallback}` && randomAttemptCount < 10) {
        randomAttemptCount++;
        return { allocationId: "colliding-room" };
      }
      return origGet(k);
    };

    // Call allocateAlias on server
    const allocated = await server.allocateAlias(storage, targetAllocationId, `ott-${targetAllocationId}`);
    assert.notEqual(allocated, derivedFallback, "Allocated alias should not hijack existing alias");

    // The pre-existing alias record must remain intact
    const preserved = await origGet(`alias:${derivedFallback}`);
    assert.equal(preserved.allocationId, "pre-existing-allocation");
  });

  it("Bug 5: advancing completed tournament returns 409 tournament_already_completed", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create and complete 1-round tournament
    const createRes = await post("/control/tournament-create", {
      name: "Completed Advance Cup",
      organizerName: "Director Eve",
      formatId: "swiss",
      mapId: "classic",
      requestedRounds: 1,
    });
    const { tournamentId, organizerSecret } = createRes.data;
    await post("/control/tournament-register", { tournamentId, name: "P1" });
    await post("/control/tournament-register", { tournamentId, name: "P2" });
    await post("/control/tournament-start", { tournamentId, organizerSecret });

    const getRes = await post("/control/tournament-get", { tournamentId });
    const match = getRes.data.tournament.currentRoundMatches[0];

    await post("/internal/terminalize", {
      allocationId: match.allocationId,
      roomId: `ott-${match.allocationId}`,
      reason: "goal",
      winner: "A",
    }, { "x-ott-internal-secret": "internal-tournament-secret" });

    await post("/control/tournament-sync-match", { tournamentId, matchId: match.matchId });

    // Advance once -> completes tournament
    const advance1 = await post("/control/tournament-advance", { tournamentId, organizerSecret });
    assert.equal(advance1.status, 200);
    assert.equal(advance1.data.tournamentCompleted, true);

    // Advance second time -> should return 409 tournament_already_completed
    const advance2 = await post("/control/tournament-advance", { tournamentId, organizerSecret });
    assert.equal(advance2.status, 409);
    assert.equal(advance2.data.error, "tournament_already_completed");
  });

  it("claim-invite: fails closed on seat-update 503/throw/missing binding and allows safe retry without stranding token or double issuing", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    let seatUpdateMode = "503"; // "503" | "throw" | "ok"

    const gameServerMock = async (request) => {
      if (request.url.includes("/internal/seat-update")) {
        if (seatUpdateMode === "503") {
          return new Response(JSON.stringify({ error: "server_busy" }), { status: 503, headers: { "content-type": "application/json" } });
        }
        if (seatUpdateMode === "throw") {
          throw new Error("network_connection_reset");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { server, storage } = createLobbyServer(storageMap, gameServerMock);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create a waiting room and seat B invite
    const createRes = await post("/control/create", { name: "Host Player" });
    assert.equal(createRes.status, 200);
    const { allocationId, resumeCredential } = createRes.data;

    const inviteRes = await post("/control/create-invite", {
      allocationId,
      seat: "B",
      inviteeName: "Guest",
      ownerCredential: resumeCredential,
    });
    assert.equal(inviteRes.status, 200);
    const { inviteToken } = inviteRes.data;

    const claimantProofSecret = "claimant-secret-proof-1234567890abcdef";

    // 2. Initial claim attempt fails because seat-update returns 503
    seatUpdateMode = "503";
    const failClaim1 = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest",
      claimId: claimantProofSecret,
    });
    assert.equal(failClaim1.status, 503, "Must fail closed (503) instead of fake success");
    assert.equal(failClaim1.data.error, "authority_unavailable");

    // Verify invite state in storage: pending, claimProofHash established
    const pendingRecord = await storage.get(`seat-invite:${inviteToken}`);
    assert.equal(pendingRecord.claimStatus, "pending");
    assert.equal(pendingRecord.claimed, true);
    assert.equal(pendingRecord.claimedBy, "Guest");
    assert.ok(pendingRecord.claimProofHash, "Claim proof hash was established");
    assert.ok(pendingRecord.pendingCredential, "Owner credential was established for retry");

    // Room must NOT be marked playing yet
    const allocPending = await storage.get(`allocation:${allocationId}`);
    assert.equal(allocPending.status, "waiting");

    // 3. CRITICAL SECURITY TEST: Same-name outsider with NO claimId or wrong claimId is strictly DENIED
    const sameNameOutsiderNoProof = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest", // EXACT SAME PUBLIC NAME!
    });
    assert.equal(sameNameOutsiderNoProof.status, 400, "Same-name outsider without claimant proof must be denied");
    assert.equal(sameNameOutsiderNoProof.data.error, "invite_already_claimed");

    const sameNameOutsiderWrongProof = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest", // EXACT SAME PUBLIC NAME!
      claimId: "wrong-claimant-proof-0987654321fedcba",
    });
    assert.equal(sameNameOutsiderWrongProof.status, 400, "Same-name outsider with wrong proof must be denied");
    assert.equal(sameNameOutsiderWrongProof.data.error, "invite_already_claimed");

    // 4. Retry by genuine claimant when seat-update throws network error -> still fails closed 503
    seatUpdateMode = "throw";
    const failClaim2 = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest",
      claimId: claimantProofSecret,
    });
    assert.equal(failClaim2.status, 503, "Network throw must fail closed (503)");
    assert.equal(failClaim2.data.error, "authority_unavailable");

    // 5. Game server recovers; retry by genuine claimant with matching proof succeeds!
    seatUpdateMode = "ok";
    const successClaim = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest",
      claimId: claimantProofSecret,
    });
    assert.equal(successClaim.status, 200, "Authenticated claimant retry must succeed once game server recovers");
    assert.ok(successClaim.data.ticket);
    assert.equal(successClaim.data.resumeCredential, pendingRecord.pendingCredential, "Preserves original credential ownership");

    // Verify finalized storage state: confirmed and pendingCredential PURGED
    const confirmedRecord = await storage.get(`seat-invite:${inviteToken}`);
    assert.equal(confirmedRecord.claimStatus, "confirmed");
    assert.equal(confirmedRecord.pendingCredential, undefined, "Plaintext pendingCredential must be purged on confirmed");

    const allocConfirmed = await storage.get(`allocation:${allocationId}`);
    assert.equal(allocConfirmed.status, "playing");
    assert.equal(allocConfirmed.names.B, "Guest");
    assert.equal(allocConfirmed.seats, 2);

    // 6. Further claim after confirmed is rejected as already claimed
    const afterConfirmed = await post("/control/claim-invite", {
      inviteToken,
      name: "Guest",
      claimId: claimantProofSecret,
    });
    assert.equal(afterConfirmed.status, 400);
    assert.equal(afterConfirmed.data.error, "invite_already_claimed");
  });

  it("tournament-start: concurrent starts do not double provision or clobber storage with stale in-memory state", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    let initCalls = 0;

    const gameServerMock = async (request) => {
      if (request.url.includes("/internal/initialize")) {
        initCalls++;
        await new Promise((r) => setTimeout(r, 15)); // Simulate network latency during game init
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { server, storage } = createLobbyServer(storageMap, gameServerMock);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    const createRes = await post("/control/tournament-create", {
      name: "Concurrent Start Cup",
      organizerName: "Director Frank",
      formatId: "swiss",
      mapId: "classic",
      requestedRounds: 1,
    });
    const { tournamentId, organizerSecret } = createRes.data;
    await post("/control/tournament-register", { tournamentId, name: "P1" });
    await post("/control/tournament-register", { tournamentId, name: "P2" });

    // Two concurrent calls to tournament-start
    const [start1, start2] = await Promise.all([
      post("/control/tournament-start", { tournamentId, organizerSecret }),
      post("/control/tournament-start", { tournamentId, organizerSecret }),
    ]);

    const statuses = [start1.status, start2.status].sort();
    assert.deepEqual(statuses, [200, 409], "Exactly one start should succeed (200) and the other rejected (409)");

    const rejected = start1.status === 409 ? start1 : start2;
    assert.equal(rejected.data.error, "tournament_already_started");

    // Exactly one match provisioned for round 1
    const tourGet = await post("/control/tournament-get", { tournamentId });
    assert.equal(tourGet.status, 200);
    const matches = tourGet.data.tournament.currentRoundMatches;
    assert.equal(matches.length, 1);
    assert.ok(matches[0].allocationId);
    assert.ok(matches[0].alias);

    // Verify only 1 allocation created in storage (no duplicate room)
    const allocations = await storage.list({ prefix: "allocation:" });
    assert.equal(allocations.size, 1);

    // Verify persisted provisioning fence was cleaned up after completion
    const fence = await storage.get(`provisioning-fence:${tournamentId}`);
    assert.equal(fence, undefined, "Provisioning fence must be deleted after provisioning completes");
  });

  it("security: outsider seatA create/claim denied, no alias-as-auth, creator credentials preserved", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server, storage } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Creator creates an ordinary room
    const createRes = await post("/control/create", { name: "Alice Creator" });
    assert.equal(createRes.status, 200);
    const { allocationId, alias, resumeCredential } = createRes.data;

    // Snapshot Alice's initial owner credentials
    const originalCred = await storage.get(`owner-credential:${allocationId}:A`);
    assert.ok(originalCred, "Alice's owner credentials must exist");

    // 2a. Outsider attempts create-invite without owner credentials -> MUST BE DENIED (401)
    const outsiderNoCredRes = await post("/control/create-invite", {
      allocationId,
      seat: "B",
      inviteeName: "Outsider",
    });
    assert.equal(outsiderNoCredRes.status, 401, "Outsider without owner credential cannot create invites");
    assert.equal(outsiderNoCredRes.data.error, "unauthorized");

    // 2b. Attempt create-invite with seat: "A" even with valid owner credentials -> MUST BE DENIED (403)
    const createSeatARes = await post("/control/create-invite", {
      allocationId,
      seat: "A",
      inviteeName: "Outsider",
      ownerCredential: resumeCredential,
    });
    assert.equal(createSeatARes.status, 403, "Seat A create-invite must be denied even for room owner");
    assert.equal(createSeatARes.data.error, "seat_already_occupied");

    // 3. Outsider attempts create-invite using alias instead of canonical allocationId -> MUST BE DENIED (401)
    const createWithAliasRes = await post("/control/create-invite", {
      allocationId: alias,
      seat: "B",
      inviteeName: "Bob",
    });
    assert.equal(createWithAliasRes.status, 401, "Alias cannot be used as authorization to create invites");
    assert.equal(createWithAliasRes.data.error, "unauthorized");

    // 4. If a seat A invite somehow existed in storage, claiming it on ordinary room MUST BE DENIED (403)
    const rogueInviteToken = "inv_rogue_seat_a_token";
    await storage.put(`seat-invite:${rogueInviteToken}`, {
      allocationId,
      roomId: `ott-${allocationId}`,
      seat: "A",
      inviteToken: rogueInviteToken,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      claimed: false,
      claimStatus: "unclaimed",
    });

    const claimSeatARes = await post("/control/claim-invite", {
      inviteToken: rogueInviteToken,
      name: "Rogue Impostor",
      claimId: "rogue-proof-1234567890abcdef",
    });
    assert.equal(claimSeatARes.status, 403, "Outsider claim for seat A on ordinary room must be denied");
    assert.equal(claimSeatARes.data.error, "seat_already_occupied");

    // 5. Verify Alice's credentials in storage remain 100% UNTOUCHED
    const finalCred = await storage.get(`owner-credential:${allocationId}:A`);
    assert.deepEqual(finalCred, originalCred, "Alice's credentials must never be overwritten");

    // 6. Alice can still resume her room using her original resumeCredential
    const resumeRes = await post("/control/resume", {
      allocationId,
      resumeCredential,
    });
    assert.equal(resumeRes.status, 200, "Alice must still be able to resume with her original credentials");
  });

  it("competing Seat B claims & ordinary join CAS reservation mutual exclusion", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    let seatUpdateMode = "ok";

    const gameServerMock = async (request) => {
      if (request.url.includes("/internal/seat-update")) {
        if (seatUpdateMode === "503") {
          return new Response(JSON.stringify({ error: "server_busy" }), { status: 503, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { server, storage } = createLobbyServer(storageMap, gameServerMock);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    // 1. Create ordinary room with creator "Alice"
    const createRes = await post("/control/create", { name: "Alice" });
    assert.equal(createRes.status, 200);
    const { allocationId, resumeCredential } = createRes.data;

    // 2. Create two independent B invites for the room
    const inv1 = await post("/control/create-invite", {
      allocationId,
      seat: "B",
      inviteeName: "Bob",
      ownerCredential: resumeCredential,
    });
    assert.equal(inv1.status, 200);
    const token1 = inv1.data.inviteToken;

    const inv2 = await post("/control/create-invite", {
      allocationId,
      seat: "B",
      inviteeName: "Charlie",
      ownerCredential: resumeCredential,
    });
    assert.equal(inv2.status, 200);
    const token2 = inv2.data.inviteToken;

    // 3. Concurrent claim: Bob and Charlie both try to claim Seat B
    const [claimBob, claimCharlie] = await Promise.all([
      post("/control/claim-invite", { inviteToken: token1, name: "Bob", claimId: "bob-proof-1234567890abcdef" }),
      post("/control/claim-invite", { inviteToken: token2, name: "Charlie", claimId: "charlie-proof-1234567890abcdef" }),
    ]);

    const statuses = [claimBob.status, claimCharlie.status].sort();
    assert.deepEqual(statuses, [200, 409], "Exactly one claim succeeds (200) and the other is rejected (409)");

    const winner = claimBob.status === 200 ? "Bob" : "Charlie";
    const loserToken = winner === "Bob" ? token2 : token1;
    const loserProof = winner === "Bob" ? "charlie-proof-1234567890abcdef" : "bob-proof-1234567890abcdef";
    const loserName = winner === "Bob" ? "Charlie" : "Bob";

    // 4. Sequential retry by loser is strictly rejected (409)
    const loserRetry = await post("/control/claim-invite", {
      inviteToken: loserToken,
      name: loserName,
      claimId: loserProof,
    });
    assert.equal(loserRetry.status, 409);
    assert.equal(loserRetry.data.error, "seat_already_occupied");

    // 5. Ordinary join on the room is also strictly rejected (409)
    const joinRes = await post("/control/join", { allocationId, name: "Dave" });
    assert.equal(joinRes.status, 409);
    assert.equal(joinRes.data.error, "not_available");

    // 6. Test ordinary join vs pending claim:
    // Create Room 2, create invite, claim fails closed with 503 -> pending claim
    const room2 = await post("/control/create", { name: "Host 2" });
    assert.equal(room2.status, 200);
    const room2Id = room2.data.allocationId;
    const room2Cred = room2.data.resumeCredential;

    const room2Inv = await post("/control/create-invite", {
      allocationId: room2Id,
      seat: "B",
      inviteeName: "PendingGuest",
      ownerCredential: room2Cred,
    });
    assert.equal(room2Inv.status, 200);
    const pendingToken = room2Inv.data.inviteToken;
    const pendingProof = "pending-proof-1234567890abcdef";

    seatUpdateMode = "503";
    const claimPending = await post("/control/claim-invite", {
      inviteToken: pendingToken,
      name: "PendingGuest",
      claimId: pendingProof,
    });
    assert.equal(claimPending.status, 503, "Claim must fail closed with 503");

    // While invite is pending, ordinary join MUST be rejected (409)
    const joinWhilePending = await post("/control/join", { allocationId: room2Id, name: "Intruder" });
    assert.equal(joinWhilePending.status, 409, "Join while claim is pending must be rejected");

    // While invite is pending, create-invite for Seat B MUST be rejected (409)
    const createWhilePending = await post("/control/create-invite", {
      allocationId: room2Id,
      seat: "B",
      inviteeName: "Another",
      ownerCredential: room2Cred,
    });
    assert.equal(createWhilePending.status, 409, "Create invite while seat has pending reservation must be rejected");

    // When GameServer recovers, original claimant with valid proof retries successfully
    seatUpdateMode = "ok";
    const retrySuccess = await post("/control/claim-invite", {
      inviteToken: pendingToken,
      name: "PendingGuest",
      claimId: pendingProof,
    });
    assert.equal(retrySuccess.status, 200, "Retry with original proof must succeed");
    assert.equal(retrySuccess.data.seat, "B");
  });

  it("initializing guard: rejects create-invite, claim-invite, and join while room is initializing", async () => {
    await getLobbyServerClass();
    const storageMap = new Map();
    const { server, storage } = createLobbyServer(storageMap);

    let clientCounter = 1;
    const post = async (pathUrl, body, extraHeaders = {}) => {
      const response = await server.fetch(
        new Request("https://ott.local" + pathUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `client-${clientCounter++}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        })
      );
      return { status: response.status, data: await response.json() };
    };

    const id = "init-alloc-123";
    await storage.put(`allocation:${id}`, {
      id,
      roomId: `ott-${id}`,
      names: { A: "Creator" },
      seats: 1,
      status: "initializing",
      creatorAttachDeadlineMs: Date.now() + 60_000,
    });

    // 1. create-invite while initializing -> 409
    const createRes = await post("/control/create-invite", { allocationId: id, seat: "B" });
    assert.equal(createRes.status, 409);
    assert.equal(createRes.data.error, "room_unavailable");

    // 2. claim-invite while initializing -> 409
    const inviteToken = "inv_init_token";
    await storage.put(`seat-invite:${inviteToken}`, {
      allocationId: id,
      roomId: `ott-${id}`,
      seat: "B",
      inviteToken,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      claimed: false,
      claimStatus: "unclaimed",
    });

    const claimRes = await post("/control/claim-invite", { inviteToken, name: "Guest" });
    assert.equal(claimRes.status, 409);
    assert.equal(claimRes.data.error, "room_unavailable");

    // 3. join while initializing -> 409
    const joinRes = await post("/control/join", { allocationId: id, name: "Guest" });
    assert.equal(joinRes.status, 409);
    assert.equal(joinRes.data.error, "not_available");
  });
});
