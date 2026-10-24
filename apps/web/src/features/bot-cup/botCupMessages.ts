/** Vietnamese messages for Bot Cup API error codes (apps/bot-cup-api). Raw codes are never shown to players. */
import { BotCupApiError } from "./BotCupApiGateway";

export const BOT_CUP_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_request: "Thông tin gửi lên không hợp lệ. Hãy kiểm tra lại các ô.",
  mssv_invalid: "MSSV phải gồm đúng 8 chữ số.",
  mssv_not_eligible: "Giải này chỉ dành cho sinh viên K71 (MSSV bắt đầu bằng 26).",
  mssv_taken: "MSSV này đã thuộc một đội khác trong giải.",
  email_invalid: "Địa chỉ email không hợp lệ.",
  email_not_allowed: "Hãy dùng email trường MSSV@vnu.edu.vn.",
  email_taken: "Email này đã được dùng cho một thành viên khác.",
  handle_invalid: "Tên đăng nhập gồm 3–24 ký tự a–z, 0–9 hoặc dấu gạch ngang, không bắt đầu hay kết thúc bằng gạch ngang.",
  handle_reserved: "Tên đăng nhập này đã được dành riêng, hãy chọn tên khác.",
  handle_taken: "Tên đăng nhập đã có đội dùng.",
  display_name_invalid: "Tên đội cần ít nhất 3 ký tự.",
  display_name_blocked: "Tên đội có từ không phù hợp, hãy chọn tên khác.",
  display_name_taken: "Tên đội đã có (hoặc quá giống tên một đội khác).",
  full_name_invalid: "Nhập họ và tên đầy đủ.",
  password_weak: "Mật khẩu cần từ 10 đến 128 ký tự.",
  password_mismatch: "Mật khẩu hiện tại không đúng.",
  consent_required: "Bạn cần đồng ý với thể lệ và việc xử lý dữ liệu cá nhân.",
  registration_closed: "Ngoài thời gian đăng ký.",
  turnstile_failed: "Không xác minh được bạn không phải máy. Hãy thử lại.",
  rate_limited: "Bạn thao tác quá nhiều lần. Hãy đợi một lúc rồi thử lại.",
  otp_invalid: "Mã xác minh không đúng.",
  otp_expired: "Mã xác minh đã hết hạn. Hãy gửi lại mã mới.",
  otp_locked: "Nhập sai quá nhiều lần. Hãy gửi lại mã mới.",
  login_failed: "Sai tên đăng nhập hoặc mật khẩu.",
  login_locked: "Đăng nhập sai quá nhiều lần. Tài khoản tạm khóa 15 phút.",
  verification_required: "Đội chưa xác minh email. Hãy nhập mã OTP đã gửi tới đội trưởng.",
  unauthorized: "Phiên đăng nhập đã hết. Hãy đăng nhập lại.",
  not_found: "Không tìm thấy.",
  not_group: "Đội cá nhân không thể thêm thành viên.",
  team_full: "Đội đã đủ 3 người.",
  captain_required: "Không thể xoá đội trưởng.",
  already_confirmed: "Thành viên này đã xác nhận.",
  invite_invalid: "Lời mời không hợp lệ hoặc đã bị huỷ.",
  invite_used: "Lời mời này đã được dùng.",
  invite_expired: "Lời mời đã hết hạn. Hãy nhờ đội trưởng gửi lại.",
  email_unavailable: "Chưa gửi được email. Hãy thử lại sau ít phút.",
  event_unavailable: "Giải đấu chưa mở.",
  forbidden_origin: "Yêu cầu bị chặn. Hãy tải lại trang.",
  network_error: "Không kết nối được máy chủ giải đấu. Kiểm tra mạng rồi thử lại.",
  method_not_allowed: "Thao tác không được hỗ trợ.",
  conflict: "Thông tin trùng với một đội khác.",
  team_not_active: "Đội cần đủ thành viên xác nhận trước khi nộp bài.",
  team_disqualified: "Đội đã bị Ban tổ chức loại khỏi giải.",
  submissions_not_open: "Chưa tới giờ mở nộp bài.",
  code_frozen: "Đã khóa code: không nộp thêm hay đổi Bản thi đấu được nữa.",
  submission_too_large: "File quá 200 KB.",
  submission_binary: "File có ký tự nhị phân. Hãy nộp file mã nguồn văn bản (.py, .js hoặc .mjs).",
  submission_encoding: "File phải lưu ở mã hóa UTF-8.",
  submission_extension: "Chỉ nhận một file .py (Python 3.12) hoặc .js / .mjs (Node 22).",
  submission_empty: "File rỗng.",
  submission_duplicate: "Bản này giống hệt một phiên bản đội đã nộp.",
  submission_daily_limit: "Đội đã nộp đủ 10 lần hôm nay. Hạn mức đặt lại lúc 00:00.",
  submission_version_limit: "Đội đã nộp đủ 200 phiên bản.",
  submission_not_eligible: "Phiên bản này không qua kiểm tra nên không chọn làm Bản thi đấu được.",
  practice_opponent_invalid: "Chọn một house bot để đấu.",
  practice_map_invalid: "Bản đồ không hợp lệ.",
  practice_no_submission: "Đội chưa có bài nộp nào để đấu luyện tập.",
  practice_not_ready: "Bản thi đấu chưa qua kiểm tra. Chờ máy chấm kiểm tra xong rồi thử lại.",
  practice_daily_limit: "Đội đã dùng hết 20 ván luyện tập hôm nay. Hạn mức đặt lại lúc 00:00.",
  appeal_invalid: "Khiếu nại cần chọn giai đoạn và viết 10–2000 ký tự.",
  appeal_not_entrant: "Chỉ đội có bài được niêm phong mới gửi khiếu nại.",
  appeal_window_closed: "Ngoài thời hạn khiếu nại của giai đoạn này.",
  appeal_limit: "Đội đã gửi đủ 3 khiếu nại cho giai đoạn này.",
  server_misconfigured: "Máy chủ giải đấu đang bảo trì.",
  internal_error: "Máy chủ gặp sự cố. Hãy thử lại sau.",
};

const FALLBACK = "Đã có lỗi xảy ra. Hãy thử lại.";

export function botCupErrorMessage(error: unknown): string {
  if (error instanceof BotCupApiError) {
    if (error.code === "login_locked" && error.retryAfterMs) {
      return `Đăng nhập sai quá nhiều lần. Thử lại sau ${Math.max(1, Math.ceil(error.retryAfterMs / 60000))} phút.`;
    }
    return BOT_CUP_ERROR_MESSAGES[error.code] ?? FALLBACK;
  }
  return FALLBACK;
}

/** API `field` values ("captain.mssv") mapped to the form field they belong to ("mssv"). */
export function errorField(error: unknown): string | null {
  if (!(error instanceof BotCupApiError) || !error.field) return null;
  return error.field.replace(/^captain\./, "");
}

const TEAM_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending_captain: "Chờ đội trưởng xác minh email",
  pending_members: "Chờ thành viên xác nhận",
  active: "Đã đủ điều kiện",
};

export function teamStatusLabel(status: string): string {
  return TEAM_STATUS_LABEL[status] ?? status;
}
