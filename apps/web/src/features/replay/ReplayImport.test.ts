import { describe, expect, it, vi } from "vitest";
import {
  MAX_REPLAY_FILE_BYTES,
  downloadReplayDocument,
  parseReplayFile,
  serializeReplayDocument,
} from "./replayImport";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import forfeitFixture from "../../../../../tests/fixtures/arena/replays/forfeit-ply0.json";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";

describe("ReplayImport", () => {
  it("enforces the 8 MiB limit before parsing JSON", async () => {
    expect(MAX_REPLAY_FILE_BYTES).toBe(8 * 1024 * 1024);

    // Create a mock file with size reported as 8 MiB + 1 byte
    const oversizedBlob = new Blob(["{}"], { type: "application/json" });
    const oversizedFile = new File([oversizedBlob], "large-replay.json", { type: "application/json" });
    Object.defineProperty(oversizedFile, "size", { value: 8 * 1024 * 1024 + 1 });

    const result = await parseReplayFile(oversizedFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/8\s*MiB/i);
    }
  });

  it("returns a retryable error for invalid JSON syntax without throwing", async () => {
    const invalidFile = new File(["{ invalid json content"], "corrupt.json", { type: "application/json" });
    const result = await parseReplayFile(invalidFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/JSON/i);
    }
  });

  it("validates replay schema using shared validator and reports validation errors", async () => {
    const badDoc = { schemaVersion: 1, matchId: "bad-doc" };
    const invalidSchemaFile = new File([JSON.stringify(badDoc)], "bad-schema.json", { type: "application/json" });

    const result = await parseReplayFile(invalidSchemaFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/hợp lệ/i);
    }
  });

  it("successfully parses and validates valid controller fixtures", async () => {
    const file1 = new File([JSON.stringify(deterministicFixture)], "det.json", { type: "application/json" });
    const result1 = await parseReplayFile(file1);
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.document.matchId).toBe(deterministicFixture.matchId);
      expect(result1.document.result.acceptedPlies).toBe(19);
    }

    const file2 = new File([JSON.stringify(forfeitFixture)], "forfeit.json", { type: "application/json" });
    const result2 = await parseReplayFile(file2);
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.document.matchId).toBe(forfeitFixture.matchId);
      expect(result2.document.result.acceptedPlies).toBe(0);
      expect(result2.document.result.outcome).toBe("forfeit");
    }
  });

  it("serializes the original finalized document unchanged", () => {
    const doc = deterministicFixture as unknown as ReplayDocument;
    const serialized = serializeReplayDocument(doc);
    const roundTripped = JSON.parse(serialized);
    expect(roundTripped).toEqual(doc);
  });

  it("ensures downloadReplayDocument revokes object URL in finally even if click throws", () => {
    const doc = deterministicFixture as unknown as ReplayDocument;
    const createObjectURL = vi.fn().mockReturnValue("blob:leak-check");
    const revokeObjectURL = vi.fn();
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURL;

    const originalCreateElement = window.document.createElement.bind(window.document);
    vi.spyOn(window.document, "createElement").mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === "a") {
        el.click = () => {
          throw new Error("Simulated click failure");
        };
      }
      return el;
    });

    expect(() => downloadReplayDocument(doc)).toThrow("Simulated click failure");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:leak-check");
  });
});
