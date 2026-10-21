/** Player-facing Vietnamese text for error codes returned by the online control API and the game Worker. */
const MESSAGES: Readonly<Record<string, string>> = {
  not_found: "Không tìm thấy phòng. Hãy kiểm tra lại mã phòng.",
  alias_not_found: "Không tìm thấy phòng. Hãy kiểm tra lại mã phòng.",
  invalid_alias: "Mã phòng không hợp lệ.",
  not_available: "Phòng đã đủ người hoặc ván đã bắt đầu.",
  room_unavailable: "Phòng không còn khả dụng.",
  seat_already_occupied: "Ghế này đã có người ngồi.",
  invite_not_found: "Mã mời không tồn tại.",
  invite_expired: "Mã mời đã hết hạn.",
  invite_already_claimed: "Mã mời đã được dùng.",
  resume_rejected: "Không thể vào lại ván này. Có thể ván đã kết thúc.",
  rate_limited: "Bạn thao tác quá nhanh. Hãy thử lại sau giây lát.",
  invalid_name: "Tên người chơi không hợp lệ.",
  invalid_request: "Yêu cầu không hợp lệ.",
  authority_unavailable: "Máy chủ online tạm thời không khả dụng.",
  attach_rejected: "Máy chủ từ chối kết nối vào phòng. Hãy thử lại.",
  attach_replayed: "Phiên kết nối đã được dùng. Hãy vào lại phòng.",
  attach_timeout: "Không kết nối được vào phòng. Hãy thử lại.",
  online_unavailable: "Online hiện không khả dụng.",
};

const TECHNICAL = /^[a-z][a-z0-9_]*$|^Online request failed|PlayHTML|attach was not accepted/i;

/** Maps an error (code, Error or message payload) to text that is safe to show to players. */
export function onlineErrorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "string" && MESSAGES[cause]) return MESSAGES[cause];
  const record = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  for (const key of ["code", "error", "message"] as const) {
    const value = record?.[key];
    if (typeof value === "string" && MESSAGES[value]) return MESSAGES[value];
  }
  const message = typeof record?.message === "string" ? record.message : typeof cause === "string" ? cause : "";
  // Keep human sentences from the client/runtime, but never show raw codes or internals.
  return message && !TECHNICAL.test(message) ? message : fallback;
}

/** True when the server answered that this room or seat can never be resumed. */
export function isPermanentRoomError(cause: unknown): boolean {
  const record = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  const code = typeof record?.code === "string" ? record.code : typeof record?.error === "string" ? record.error : typeof record?.message === "string" ? record.message : "";
  return ["resume_rejected", "not_found", "room_unavailable", "not_available"].includes(code) || record?.status === 401 || record?.status === 404 || record?.status === 410;
}
