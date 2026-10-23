# Bot Cup — tiến độ triển khai (checkpoint)

Nguồn chuẩn về phạm vi: [`2026-10-23-uet-k71-bot-cup.md`](2026-10-23-uet-k71-bot-cup.md). File này chỉ ghi trạng thái làm việc
để phiên sau tiếp tục ngay. Cập nhật sau mỗi nhóm thay đổi.

Quyền đã được chủ dự án cho (2026-10-24): làm liên tục P3→P9; được migrate/deploy/đặt secret **staging**
(`ottv2-bot-cup-api-staging`, D1 `ottv2-bot-cup-staging`); được chạy runner trên máy này nối staging với bot mẫu/bot tổng hợp;
đăng nhập BTC = Cloudflare Access (mặc định) + mật khẩu/TOTP dự phòng bật bằng biến môi trường. Không production, không push
tag, không merge `main`.

## Trạng thái

| Pha | Trạng thái | Nhánh | Evidence |
|---|---|---|---|
| P0–P2 | ✅ (xem plan) | đã merge (PR #31) + `docs/bot-cup-p2-staging` | `docs/evidence/2026-10-24-bot-cup-p{0,1,2}.md` |
| P3 | ✅ [D] | `feat/bot-cup-p3` | `docs/evidence/2026-10-24-bot-cup-p3.md` |
| P4 | ✅ | `feat/bot-cup-p3` | `docs/evidence/2026-10-24-bot-cup-p4.md` |
| P5 | ✅ [D] (Elo ladder [T] chưa làm) | `feat/bot-cup-p3` | `docs/evidence/2026-10-24-bot-cup-p5.md` |
| P6 | ⏳ tiếp theo | — | — |

## Ghi chú cho phiên sau

- Shell: heredoc chứa dấu nháy/backtick hay lỗi trong Bash tool → dùng Write/Edit cho file nhiều dòng.
- Staging có đội thử `p3-check` (id `p3-check-team`, không thành viên, mật khẩu vô hiệu) và 2 bài nộp template.
- Dev local: `npm run bot-cup:api:dev` (cổng 8789, outbox `Authorization: Bearer dev`) + `VITE_OTT_BOT_CUP_ENABLED=true npx vite --config apps/web/vite.config.ts`.
- Staging: D1 đã có migration 0001–0004; Worker có `BOT_CUP_RUNNER_IMAGE_ID`; token runner `var/bot-cup/runner-token-staging-main.txt`.
- Chạy runner: `BOT_CUP_RUNNER_URL=… BOT_CUP_RUNNER_TOKEN_FILE=… ARENA_RUNNER_IMAGE_ID=sha256:8e3ea65c… npm run bot-cup:runner` (`BOT_CUP_RUNNER_ONCE=true` để tự dừng).
- Máy có 12 container của dự án khác: không đụng tới. Khi đo benchmark không chạy test khác song song.
- P6 cần: Worker admin (Access JWT + dự phòng mật khẩu/TOTP theo env), bảng `admins`, audit log chuỗi băm, 2 admin cho loại đội/sửa kết quả,
  màn hình đội/bài nộp/runner/job/cờ, chạy lại job, xuất CSV.
