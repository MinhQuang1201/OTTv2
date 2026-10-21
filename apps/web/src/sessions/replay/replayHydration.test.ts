import { describe, expect, it } from "vitest";
import deterministicMatch from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import forfeitPly0 from "../../../../../tests/fixtures/arena/replays/forfeit-ply0.json";
import type { ReplayDocument } from "../contract";
import {
  DEFAULT_COMPATIBLE_ENGINE_REVISIONS,
  DEFAULT_COMPATIBLE_RULESET_HASHES,
  hydratePracticeCoreState,
  validatePracticeStart,
} from "./replayHydration";

describe("replayHydration", () => {
  it("rejects fake fixture engine revisions (test-engine-rev and engine-rev-001) by default in production", () => {
    // deterministicMatch has engineRevision "sha256:test-engine-rev"
    const result1 = hydratePracticeCoreState(deterministicMatch as unknown as ReplayDocument, 5);
    expect(result1.ok).toBe(false);
    if (!result1.ok) {
      expect(result1.reason).toContain("engine");
    }

    // forfeitPly0 has engineRevision "sha256:engine-rev-001"
    const result2 = hydratePracticeCoreState(forfeitPly0 as unknown as ReplayDocument, 0);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.reason).toContain("engine");
    }
  });

  it("hydrates a valid mid-game frame cleanly with actual current core G fingerprint", () => {
    const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    // Use actual current Core G revision from production allowlist
    doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    const result = hydratePracticeCoreState(doc, 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.practice.parentMatchId).toBe("match-det-001");
    expect(result.practice.parentPly).toBe(5);
    expect(result.practice.rulesetId).toBe("ottv2-g-default-v1");
    expect(result.practice.rulesetHash).toBe(doc.rulesetHash);
    expect(result.practice.engineRevision).toBe(DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0]);
    expect(result.practice.practiceId).toBeTruthy();

    // Preserves turn
    expect(result.practice.coreState.turn).toBe("B");
    expect(result.practice.coreState.winner).toBeNull();
    expect(result.practice.coreState.reason).toBeNull();

    // Resets clock to fresh 600,000 ms budget
    expect(result.practice.coreState.clock.remainingMs.A).toBe(600000);
    expect(result.practice.coreState.clock.remainingMs.B).toBe(600000);
    expect(result.practice.coreState.clock.runningSeat).toBe("B");

    // Deep independence: modifying practice state does not mutate document
    const originalPieceCount = doc.frames[5].coreState.pieces.length;
    result.practice.coreState.pieces.pop();
    expect(doc.frames[5].coreState.pieces.length).toBe(originalPieceCount);
  });

  it("allows forking non-terminal frame from forfeit-ply0 when compatibility options are injected", () => {
    const doc = structuredClone(forfeitPly0) as unknown as ReplayDocument;
    const result = hydratePracticeCoreState(doc, 0, {
      compatibleEngineRevisions: ["sha256:engine-rev-001"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.practice.parentMatchId).toBe("match-test-replay-001");
    expect(result.practice.parentPly).toBe(0);
    expect(result.practice.coreState.turn).toBe("A");
    expect(result.practice.coreState.winner).toBeNull();
  });

  it("guards document.frames array before checking cursor bounds", () => {
    const malformedDoc = structuredClone(deterministicMatch) as any;
    delete malformedDoc.frames;
    expect(hydratePracticeCoreState(malformedDoc, 0).ok).toBe(false);

    malformedDoc.frames = null;
    expect(hydratePracticeCoreState(malformedDoc, 0).ok).toBe(false);

    malformedDoc.frames = "not-an-array";
    expect(hydratePracticeCoreState(malformedDoc, 0).ok).toBe(false);
  });

  it("rejects forking a terminal frame where coreState already has a winner", () => {
    const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    // ply 19 is terminal goal win for A
    const result = hydratePracticeCoreState(doc, 19);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("kết thúc");
  });

  it("rejects unknown engine revision and unknown ruleset hash", () => {
    const docUnknownEngine = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    (docUnknownEngine as any).engineRevision = "sha256:unknown-future-engine";
    const res1 = hydratePracticeCoreState(docUnknownEngine, 3);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.reason).toContain("engine");
    }

    const docUnknownRuleset = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    docUnknownRuleset.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    (docUnknownRuleset as any).rulesetHash = "sha256:unknown-ruleset-hash";
    const res2 = hydratePracticeCoreState(docUnknownRuleset, 3);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.reason).toContain("bộ luật");
    }
  });

  it("rejects invalid cursor out of bounds", () => {
    const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    expect(hydratePracticeCoreState(doc, -1).ok).toBe(false);
    expect(hydratePracticeCoreState(doc, 999).ok).toBe(false);
  });

  it("does not resurrect captured pieces from earlier plies", () => {
    const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    const resultPly18 = hydratePracticeCoreState(doc, 18);
    expect(resultPly18.ok).toBe(true);
    if (!resultPly18.ok) return;

    expect(resultPly18.practice.coreState.pieces.length).toBe(
      doc.frames[18].coreState.pieces.length
    );
  });

  it("rejects board states with goal square occupancy detected by core truth", () => {
    const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
    doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
    // Simulate player A already reaching goal (0,0) in frame 10
    const tampered = structuredClone(doc);
    tampered.frames[10].coreState.pieces.push({
      id: "A-goal-cheat",
      player: "A",
      type: "la",
      x: 0,
      y: 0,
    });
    const result = hydratePracticeCoreState(tampered, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("kết thúc");
    }
  });

  describe("validatePracticeStart", () => {
    it("validates genuine PracticeStart envelope and returns deep clone", () => {
      const doc = structuredClone(deterministicMatch) as unknown as ReplayDocument;
      doc.engineRevision = DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0];
      const hydrated = hydratePracticeCoreState(doc, 5);
      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      const validated = validatePracticeStart(hydrated.practice);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;

      expect(validated.validated.practiceId).toBe(hydrated.practice.practiceId);
      expect(validated.validated.engineRevision).toBe(DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0]);
    });

    it("rejects forged practice with winner set, duplicate cells, or unknown engine", () => {
      const basePractice = {
        practiceId: "forged-practice-1",
        parentMatchId: "match-001",
        parentPly: 5,
        rulesetId: "ottv2-g-default-v1",
        rulesetHash: DEFAULT_COMPATIBLE_RULESET_HASHES[0],
        engineRevision: DEFAULT_COMPATIBLE_ENGINE_REVISIONS[0],
        coreState: {
          turn: "B" as const,
          winner: null,
          reason: null,
          eliminatedPlayer: null,
          clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "B" as const },
          pieces: [
            { id: "A-la-0", player: "A" as const, type: "la" as const, x: 3, y: 4 },
            { id: "B-la-0", player: "B" as const, type: "la" as const, x: 2, y: 0 },
          ],
        },
      };

      // Forged with winner
      const forgedWinner = {
        ...basePractice,
        coreState: { ...basePractice.coreState, winner: "A" as const },
      };
      expect(validatePracticeStart(forgedWinner).ok).toBe(false);

      // Forged with duplicate cells
      const forgedDupes = {
        ...basePractice,
        coreState: {
          ...basePractice.coreState,
          pieces: [
            { id: "A-1", player: "A" as const, type: "la" as const, x: 2, y: 0 },
            { id: "B-1", player: "B" as const, type: "dam" as const, x: 2, y: 0 },
          ],
        },
      };
      expect(validatePracticeStart(forgedDupes).ok).toBe(false);

      // Forged with unknown engineRevision
      const forgedEngine = {
        ...basePractice,
        engineRevision: "sha256:unauthorized-engine",
      };
      expect(validatePracticeStart(forgedEngine).ok).toBe(false);
    });
  });
});
