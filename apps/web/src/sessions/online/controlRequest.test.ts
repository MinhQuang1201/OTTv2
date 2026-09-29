import { describe, expect, it, vi } from "vitest";
import { createControlRequest } from "./controlRequest";

describe("createControlRequest", () => {
  it("requires HTTPS, trims one trailing slash, and posts JSON without retries", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ rooms: [] }), { status: 200 }));
    const request = createControlRequest({ endpoint: "https://control.example/", fetchImpl });

    await expect(request("list", { page: 1 })).resolves.toEqual({ rooms: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://control.example/control/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: 1 }),
    });
  });

  it("exposes JSON error details without retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "room unavailable" }), { status: 409 }));
    const request = createControlRequest({ endpoint: "https://control.example", fetchImpl });

    await expect(request("join", {})).rejects.toMatchObject({ message: "room unavailable", status: 409, code: "room unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTTPS endpoints before making a request", async () => {
    const fetchImpl = vi.fn();
    const request = createControlRequest({ endpoint: "http://control.example", fetchImpl });

    await expect(request("list")).rejects.toThrow("HTTPS required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
