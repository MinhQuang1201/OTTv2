import { describe, expect, it } from "vitest";

import {
  MAX_OTT_PAYLOAD_BYTES,
  MAX_PUBLIC_MATCHES,
  parsePublicMatchCatalog,
  validatePublicMatchCatalog,
  type PublicMatchCatalogMessage,
  type PublicMatchView,
} from "../../../../../packages/protocol/src/index";
import { normalizePublicMatchSummary } from "../../../../../apps/worker/src/lobby/public-match";

const allocationId = "123e4567-e89b-12d3-a456-426614174000";
const roomId = `ott-${allocationId}`;

function match(overrides: Partial<PublicMatchView> = {}): PublicMatchView {
  return {
    allocationId,
    roomId,
    status: "playing",
    players: {
      A: { seat: "A", name: "Alice", connected: true, remainingMs: 600_000 },
      B: { seat: "B", name: "Bob", connected: false, remainingMs: 599_000 },
    },
    spectatorCount: 2,
    serverNow: 1_700_000_000_000,
    runningSeat: "A",
    ...overrides,
  };
}

function message(overrides: Partial<PublicMatchCatalogMessage> = {}): PublicMatchCatalogMessage {
  return {
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 4,
    matches: [match()],
    ...overrides,
  };
}

describe("public match protocol", () => {
  it("accepts a valid active-match envelope", () => {
    const result = parsePublicMatchCatalog(JSON.stringify(message()));

    expect(result).toEqual({ ok: true, value: message() });
  });

  it("accepts an older structurally valid revision for downstream stale filtering", () => {
    const current = parsePublicMatchCatalog(JSON.stringify(message({ catalogRevision: 4 })));
    const older = parsePublicMatchCatalog(JSON.stringify(message({ catalogRevision: 3 })));

    expect(current.ok).toBe(true);
    expect(older.ok).toBe(true);
    if (current.ok && older.ok) {
      expect(older.value.catalogRevision).toBeLessThan(current.value.catalogRevision);
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects catalog revision %s",
    (catalogRevision) => {
      expect(parsePublicMatchCatalog(JSON.stringify(message({ catalogRevision })))).toEqual({
        ok: false,
        error: "invalid_public_match_catalog",
      });
    },
  );

  it("rejects duplicate match IDs and non-playing matches", () => {
    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [match(), match()] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [match({ status: "finished" as "playing" })] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
  });

  it("rejects non-canonical IDs, oversized names, counts, and clocks", () => {
    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [match({ allocationId: "allocation-1" })] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
    expect(parsePublicMatchCatalog(JSON.stringify(message({
      matches: [match({ players: { ...match().players, A: { ...match().players.A, name: "x".repeat(33) } } })],
    })))).toEqual({ ok: false, error: "invalid_public_match_catalog" });
    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [match({ spectatorCount: 100_001 })] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [match({ players: { ...match().players, A: { ...match().players.A, remainingMs: -1 } } })] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
  });

  it("rejects private fields instead of allowing them through the public shape", () => {
    const privateMatch = { ...match(), ticket: "secret" };

    expect(parsePublicMatchCatalog(JSON.stringify(message({ matches: [privateMatch as PublicMatchView] })))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });
  });

  it("rejects collections beyond the finite catalog bound and UTF-8 payload limit", () => {
    const manyMatches = Array.from({ length: MAX_PUBLIC_MATCHES + 1 }, (_, index) => ({
      ...match(),
      allocationId: `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`,
      roomId: `ott-123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`,
    }));
    expect(validatePublicMatchCatalog(message({ matches: manyMatches }))).toEqual({
      ok: false,
      error: "invalid_public_match_catalog",
    });

    const oversized = JSON.stringify(message({ matches: Array.from({ length: 40 }, (_, index) => ({
      ...match(),
      allocationId: `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`,
      roomId: `ott-123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`,
    })) }));
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(MAX_OTT_PAYLOAD_BYTES);
    expect(parsePublicMatchCatalog(oversized)).toEqual({ ok: false, error: "invalid_payload" });
  });
});

describe("Worker public match normalization", () => {
  it("returns a public-only normalized summary", () => {
    const result = normalizePublicMatchSummary(match());

    expect(result).toEqual({ ok: true, value: match() });
  });

  it.each([
    { ...match(), ticket: "secret" },
    { ...match(), resumeCredential: "secret" },
    { ...match(), players: { ...match().players, A: { ...match().players.A, privateToken: "secret" } } },
  ])("rejects private or unknown summary fields", (summary) => {
    expect(normalizePublicMatchSummary(summary)).toEqual({
      ok: false,
      error: "invalid_public_match_summary",
    });
  });
});
