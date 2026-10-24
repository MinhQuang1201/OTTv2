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
| P6 | ✅ | `feat/bot-cup-p3` | `docs/evidence/2026-10-24-bot-cup-p6.md` |
| P7 | ✅ [D] (runner offline [T] chưa làm) | `feat/bot-cup-p3` (PR #32 đã merge) | `docs/evidence/2026-10-24-bot-cup-p7.md` |
| P8 | ✅ | `feat/bot-cup-p8` (PR #33 đã merge) | `docs/evidence/2026-10-24-bot-cup-p8.md` |
| P9 | 🟡 [D] một phần: diễn tập chưa chạy | `feat/bot-cup-p9` | `docs/evidence/2026-10-24-bot-cup-p9.md` |

## Điểm dừng

2026-10-24: P8 đã merge (PR #33). P9 làm một phần; chủ dự án quyết định để buổi diễn tập lại sau (dự án cá nhân, chưa có ngày thi).
Tiếp tục diễn tập: `npm run bot-cup:rehearsal -- seed --freeze-in 20` → runner nối `https://ottv2-bot-cup-api-rehearsal.opticsquang.workers.dev`
→ các bước ở `docs/bot-cup/runbook.vi.md` §2 (admin `btc-check` + `btc-check2` trên `https://ottv2-bot-cup-admin-rehearsal.opticsquang.workers.dev`)
→ trình chiếu: Vite với `OTT_BOT_CUP_API_ORIGIN=<rehearsal API>` rồi mở `?view=bot-cup&screen=projector`.

## Ghi chú cho phiên sau

- Shell: heredoc chứa dấu nháy/backtick hay lỗi trong Bash tool → dùng Write/Edit cho file nhiều dòng.
- Staging có đội thử `p3-check` (id `p3-check-team`, không thành viên, mật khẩu vô hiệu) và 2 bài nộp template.
- Dev local: `npm run bot-cup:api:dev` (cổng 8789, outbox `Authorization: Bearer dev`) + `VITE_OTT_BOT_CUP_ENABLED=true npx vite --config apps/web/vite.config.ts`.
- Staging: D1 đã có migration 0001–0007; Worker có `BOT_CUP_RUNNER_IMAGE_ID`; token runner `var/bot-cup/runner-token-staging-main.txt`.
- Chạy runner: `BOT_CUP_RUNNER_URL=… BOT_CUP_RUNNER_TOKEN_FILE=… ARENA_RUNNER_IMAGE_ID=sha256:8e3ea65c… npm run bot-cup:runner` (`BOT_CUP_RUNNER_ONCE=true` để tự dừng).
- Máy có 12 container của dự án khác: không đụng tới. Khi đo benchmark không chạy test khác song song.
- Admin staging: https://ottv2-bot-cup-admin-staging.opticsquang.workers.dev (password+TOTP). Tài khoản thử `btc-check@ottcup.test`
  (file `var/bot-cup/admin-btc-check@ottcup.test.txt`); tài khoản chủ dự án đã tạo nhưng KHÔNG dùng để thao tác.
- Local admin: `npm run bot-cup:admin:dev` (8790), tạo admin: `node scripts/bot-cup/admin-user.mjs <email> --env test --local`.
- Sự kiện staging chưa đặt `code_freeze_at` ⇒ bước khóa code bị từ chối (cố ý). Diễn tập P9 cần sự kiện/giờ khóa riêng: đừng
  khóa code sự kiện staging chính nếu còn dùng nó cho đăng ký thử.
- JPlag: `var/bot-cup/jplag/jplag-6.2.0-jar-with-dependencies.jar` (6.3.0 cần Java 25). Gọi Java bằng đường dẫn tương đối
  (đường dẫn repo có dấu tiếng Việt làm Java đọc sai đối số). Bộ thế cờ bí mật: `var/bot-cup/probe-sets/` (2 bộ 100 thế; bộ
  `59a900f4…` đã dùng trên staging).
- Git Bash đổi đối số bắt đầu bằng `/` thành đường dẫn Windows: đặt `MSYS_NO_PATHCONV=1` khi truyền đường dẫn API cho script.
- `npm run bot-cup:api:dev` từng tự thoát hai lần trong P8 (cổng 8789); chạy lại là được.
- Bot diễn tập: `var/bot-cup/rehearsal/bots/` (8 file; không commit vì repo công khai). Sự kiện `rehearsal-demo` đã seed với giờ khóa 03:30Z 24/10 (đã qua): seed lại để có giờ khóa mới.