import { describe, expect, it } from "vitest";
import { isPermanentRoomError, onlineErrorMessage } from "./onlineErrors";

describe("onlineErrorMessage", () => {
  it("translates server error codes instead of showing them raw", () => {
    expect(onlineErrorMessage(Object.assign(new Error("not_found"), { code: "not_found", status: 404 }), "x")).toBe("Không tìm thấy phòng. Hãy kiểm tra lại mã phòng.");
    expect(onlineErrorMessage({ __ott: true, type: "ott:error", error: "attach_rejected" }, "x")).toBe("Máy chủ từ chối kết nối vào phòng. Hãy thử lại.");
    expect(onlineErrorMessage("attach_timeout", "x")).toBe("Không kết nối được vào phòng. Hãy thử lại.");
  });

  it("keeps human sentences but hides unknown codes and technical text", () => {
    expect(onlineErrorMessage({ message: "Chưa kết nối máy chủ" }, "fallback")).toBe("Chưa kết nối máy chủ");
    expect(onlineErrorMessage(new Error("some_new_code"), "fallback")).toBe("fallback");
    expect(onlineErrorMessage(new Error("Online request failed (502)"), "fallback")).toBe("fallback");
    expect(onlineErrorMessage(new Error("PlayHTML host is unavailable"), "fallback")).toBe("fallback");
    expect(onlineErrorMessage(null, "fallback")).toBe("fallback");
  });
});

describe("isPermanentRoomError", () => {
  it("is true only when the room or seat can never be resumed", () => {
    expect(isPermanentRoomError({ code: "resume_rejected", status: 401 })).toBe(true);
    expect(isPermanentRoomError({ status: 410 })).toBe(true);
    expect(isPermanentRoomError({ code: "rate_limited", status: 429 })).toBe(false);
    expect(isPermanentRoomError(new Error("network down"))).toBe(false);
  });
});
