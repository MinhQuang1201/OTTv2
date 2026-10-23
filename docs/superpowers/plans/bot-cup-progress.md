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
| P4 | ⏳ tiếp theo | — | — |

## Ghi chú cho phiên sau

- Shell: heredoc chứa dấu nháy/backtick hay lỗi trong Bash tool → dùng Write/Edit cho file nhiều dòng.
- Staging có đội thử `p3-check` (id `p3-check-team`, không thành viên, mật khẩu vô hiệu) và 2 bài nộp template.
- Dev local: `npm run bot-cup:api:dev` (cổng 8789, outbox `Authorization: Bearer dev`) + `VITE_OTT_BOT_CUP_ENABLED=true npx vite --config apps/web/vite.config.ts`.
- P4 cần: policy `bot-cup-policy-v1` (500 ms, quỹ 30 s, 300 nước, ân hạn nước đầu 5 s), API `/runner/*`, `apps/bot-cup-runner`,
  smoke test chuyển `checking` → `ready`/`build_failed`/`smoke_failed`, `verifyReplay` trong `bot-cup-core`.
- P5 cần: house bot `hard` canh giờ (hết quỹ ở ván dài), link tải starter kit trên trang giải.
