# OTTv2 – Oẳn Tù Tì

Cờ chiến thuật hai người trên bàn 9×9. Mỗi bên có 10 quân: 3 Đấm, 4 Lá và 3 Kéo. Ăn theo oẳn tù tì. Thắng khi đưa quân vào ô thắng của mình, hoặc khi ăn hết toàn bộ quân đối phương.

- Người A (Đỏ) thắng trên **a1**. Người B (Xanh) thắng trên **i9**.
- Đi một ô theo 8 hướng.
- Cùng loại khác phe: nước đi bị từ chối; mỗi ô chỉ có một quân.
- Khác loại: bên thắng oẳn tù tì ăn; bên thua bị từ chối và trạng thái không đổi.

## Chạy

Cần Node.js 18 trở lên.

```powershell
npm.cmd install
npm.cmd run dev:web
```

Mở trình duyệt: [http://localhost:3000](http://localhost:3000)

Để kiểm tra đường phục vụ giống production:

```powershell
npm.cmd run build:web
npm.cmd start
```

Các lệnh kiểm tra giao diện là `npm.cmd run test:web` và
`npm.cmd run typecheck:web`. `npm.cmd test` chạy game-core, Worker, server
security và các test boundary ở gốc.

## Chơi

1. Đặt tên.
2. **Tạo phòng** — nhận mã 4 ký tự, chờ người thứ hai.
3. **Vào phòng** — nhập mã, hoặc bấm một phòng đang chờ.
4. **Hai người một máy** — luân phiên trên cùng trình duyệt.
5. **Đấu với máy** — bạn là Người A; máy là Người B.

Hai người trên cùng máy có thể chơi ngay. Chế độ AI hoạt động local. Chế độ online là mục tiêu kiến trúc worker-authoritative, nhưng hiện chưa khả dụng khi rollout còn blocked.

Tài liệu adapter PlayHTML: [http://localhost:3000/playhtml-game.html](http://localhost:3000/playhtml-game.html)

Demo fixture có thể chọn bằng query key, ví dụ `?demo=result-goal`,
`?demo=result-elimination`, `?demo=result-no-moves`, `?demo=result-timeout`,
`?demo=result-disconnect-timeout`, `?demo=result-leave`,
`?demo=game-reconnecting`, hoặc các kịch bản khán giả: `?demo=spectator-list`,
`?demo=spectator-active`, `?demo=spectator-reconnecting`, `?demo=spectator-finished`,
`?demo=spectator-room-gone`.

## Luật tóm tắt

| | |
|---|---|
| Bàn | 9×9, file a–i, rank 1–9 |
| Quân | Mỗi bên 10 quân: 3 Đấm, 4 Lá, 3 Kéo |
| Vòng ăn | Đấm > Kéo > Lá > Đấm |
| Di chuyển | 1 ô, 8 hướng; không ra ngoài bàn; không vào ô có quân cùng phe |
| Cùng loại | Không được đi vào ô có quân đối phương cùng loại |
| Ô thắng | A: a1 · B: i9 — chỉ quân của chính mình |
| Ăn hết quân | Không còn quân nào của đối phương → thắng ngay |
| Thế trận | A ở khu vực E8:H5, B đối xứng 180°; không đặt quân lên a1/i9 lúc xếp |
| Đồng hồ | 10 phút mỗi ghế; server quyết định timeout |
| Kết nối lại | Grace 60 giây; `leave` xử thua ngay, `close` giữ ghế |

Chi tiết thuật ngữ: [CONTEXT.md](CONTEXT.md).

## Ranh giới ứng dụng

```
packages/game-core/src/  Luật, cấu hình, AI local, Room
packages/protocol/src/   Hợp đồng lệnh/sự kiện dùng chung
packages/game-client/src/ Adapter PlayHTML/Worker phía browser
apps/web/src/features/    React presentation and interaction
apps/web/src/sessions/    Local, AI, demo, and online session adapters
apps/web/static/          Retained static adapter diagnostic page
apps/worker/              Worker được chia theo entry/lobby/game/auth/persistence
partykit/                 Mã legacy còn được adapter lưu trữ tham chiếu
tests/                    Luật, phòng, Worker và boundary tests
scripts/                  Build assets và runtime harness
```

Các module JavaScript chính không còn nằm ở gốc; mã canonical ở `packages/` và `apps/web/src`. Luật không nằm trong UI. Khi online được mở sau các evidence gate, `Room.handleMove` gọi `rules.applyMove`; khách chỉ vẽ trạng thái Worker gửi. Chi tiết tổ chức nằm trong [CONFIG.md](CONFIG.md).

## Kiểm thử

```bash
npm test
```

`tests/rules.test.js` — phạm vi kiểm thử luật; chạy `npm test` để xác minh kết quả trên revision hiện tại.

`tests/room.test.js` — phạm vi kiểm thử `Room`; chạy `npm test` để xác minh kết quả trên revision hiện tại.

## Biến môi trường

`PORT` — cổng HTTP static, mặc định `3000`.
`OTT_WORKER_HOST` — địa chỉ loopback cho Worker local, mặc định `127.0.0.1`.
`OTT_WORKER_PORT` — cổng Worker local; để trống để hệ điều hành cấp cổng động, hoặc đặt thủ công khi debug/CI.
`VITE_OTT_PLAYHTML_HOST` — public Worker origin dùng cho PlayHTML/YProvider trong browser build.
`VITE_OTT_PLAYHTML_CONTROL_ENDPOINT` — HTTPS/HTTP Worker origin dùng cho create/list/join/resume trong browser build.
`OTT_PLAYHTML_HOST` — endpoint self-hosted dành cho adapter; không đặt secret trong frontend.
`OTT_PLAYHTML_CONTROL_ENDPOINT` — HTTPS Worker control endpoint for create/list/join/resume; bỏ trống thì online unavailable.
`OTT_SPECTATOR_ENABLED` — cờ tính năng khán giả phía Worker, mặc định tắt (chỉ bật khi `"true"`).

## Online qua Cloudflare Worker

Kiến trúc online production duy nhất được cấu hình là Cloudflare Worker + Durable Objects trong `apps/worker/wrangler.jsonc`. PartyKit legacy không còn là route deploy hoặc authority online. Các file `partykit/` và test tương ứng được giữ lại như tài liệu/coverage legacy cho các ràng buộc bảo mật, không được dùng để deploy production.

Worker local/deploy commands:

```bash
npm run worker:dev
npx --no-install wrangler deploy --config apps/worker/wrangler.jsonc
```

`npm run worker:dev` dùng Wrangler đã pin trong repository, tự chọn cổng loopback khi `OTT_WORKER_PORT` để trống, và tắt inspector mặc định để tránh các dải cổng bị Windows loại trừ. `.env` chỉ dành cho cấu hình local không bí mật; `.dev.vars` chứa secret Worker local và không được commit. Không cần reset WinNAT hoặc thay đổi Windows dynamic port range để chạy dự án.

Để chơi thủ công local, đặt `OTT_WORKER_PORT=8900`, `VITE_OTT_PLAYHTML_HOST=http://127.0.0.1:8900` và `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT=http://127.0.0.1:8900` trong `.env`, sau đó chạy Worker và web app ở hai terminal. Không dùng cổng động cho flow này vì static frontend cần biết Worker origin trước khi build/dev server khởi động.

Local demo dùng minimal browser fork trong `vendor/playhtml-minimal/browser/`: một YProvider kết nối Worker, chờ initial sync rồi gửi các lệnh `ott:*` qua custom-message channel. Playwright đã xác nhận hai browser context có thể tạo/tham gia phòng và đồng bộ một nước đi hợp lệ. Đây không phải full upstream PlayHTML bundle.

Không dùng public PlayHTML host cho dữ liệu ván và không tạo WebSocket thứ hai. Static server chỉ phục vụ file tĩnh; authority online thuộc worker. Local và AI không phụ thuộc worker.

React session adapters chỉ render snapshot authoritative hoặc local session state.
Không ghi state ván online bằng PlayHTML shared page/element data, `can-play`,
event, presence, cursor hoặc awareness. Không thêm polling, WebSocket thứ hai,
fake factory hay fallback transport; `OTT_PLAYHTML_CONNECTION_FACTORY` là seam
tích hợp duy nhất khi runtime còn blocked.

Trạng thái production rollout: **BLOCKED**. Local demo path có runtime/two-browser evidence, nhưng Task 8 runtime/security matrix, Task 10 manual acceptance và deploy verification còn lại. Không suy rộng local demo thành production readiness. Local và AI modes vẫn hoạt động độc lập.

**Còn lại trước production:** hoàn tất runtime/security/lifecycle matrix, manual acceptance (bao gồm timeout/reconnect/expiry và credential isolation), kiểm tra deploy và chỉ cập nhật status theo evidence đã thực sự thu được. Các mục này không cần để chạy demo local hai người.
