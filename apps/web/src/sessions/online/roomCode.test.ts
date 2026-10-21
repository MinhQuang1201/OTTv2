import { describe, expect, it } from "vitest";
import { inviteLink, joinCodeFromUrl, normalizeRoomCode } from "./roomCode";

const UUID = "32dab65e-ffbf-426e-93c1-a5baf3ed4a02";

describe("normalizeRoomCode", () => {
  it("turns the room id shown in game (ott-<uuid>) into the allocation id the server expects", () => {
    expect(normalizeRoomCode(`ott-${UUID}`)).toBe(UUID);
    expect(normalizeRoomCode(`  OTT-${UUID.toUpperCase()} `)).toBe(UUID);
    expect(normalizeRoomCode(UUID.toUpperCase())).toBe(UUID);
  });

  it("keeps aliases and invite tokens, stripping only typed spaces", () => {
    expect(normalizeRoomCode(" k7n - m4p ")).toBe("k7n-m4p");
    expect(normalizeRoomCode("inv_abc123")).toBe("inv_abc123");
    expect(normalizeRoomCode("room-7")).toBe("room-7");
  });

  it("accepts a pasted invite link", () => {
    expect(normalizeRoomCode("https://ottv2-psi.vercel.app/?join=K7N-M4P")).toBe("K7N-M4P");
  });
});

describe("invite links", () => {
  it("reads ?join= from a search string or URL and ignores anything else", () => {
    expect(joinCodeFromUrl("?join=K7N-M4P")).toBe("K7N-M4P");
    expect(joinCodeFromUrl("https://x.example/play?demo=1&join=ABC-DEF")).toBe("ABC-DEF");
    expect(joinCodeFromUrl("?demo=lobby-default")).toBeNull();
    expect(joinCodeFromUrl("K7N-M4P")).toBeNull();
  });

  it("builds a link on the current page that round-trips", () => {
    const link = inviteLink("K7N-M4P", { origin: "https://ottv2-psi.vercel.app", pathname: "/" });
    expect(link).toBe("https://ottv2-psi.vercel.app/?join=K7N-M4P");
    expect(normalizeRoomCode(link)).toBe("K7N-M4P");
  });
});
