# OTTv2 – Oẳn Tù Tì

Cờ chiến thuật hai người trên bàn 9×9. Mỗi quân là Đấm, Lá hoặc Kéo. Ăn theo oẳn tù tì. Thắng khi đưa quân vào ô thắng của mình, hoặc khi ăn hết toàn bộ quân đối phương.

- Người A (Đỏ) thắng trên **a9**. Người B (Xanh) thắng trên **i1**.
- Đi như vua cờ vua: 8 hướng, 1 ô.
- Cùng loại khác phe: nước đi bị từ chối; mỗi ô chỉ có một quân.
- Khác loại: bên thắng oẳn tù tì ăn; bên thua mất quân đi (đòn thua).

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
`?demo=result-disconnect-timeout`, `?demo=result-leave` hoặc
`?demo=game-reconnecting`.

## Luật tóm tắt

| | |
|---|---|
| Bàn | 9×9, file a–i, rank 1–9 |
| Quân | Mỗi bên 9 quân: 3 Đấm, 3 Lá, 3 Kéo |
| Vòng ăn | Đấm > Kéo > Lá > Đấm |
| Di chuyển | 1 ô, 8 hướng; không ra ngoài bàn; không vào ô có quân cùng phe |
| Cùng loại | Không được đi vào ô có quân đối phương cùng loại |
| Ô thắng | A: a9 · B: i1 — chỉ quân của chính mình |
| Ăn hết quân | Không còn quân nào của đối phương → thắng ngay |
| Thế trận | A ở A3:C5, B ở G5:I7, đối xứng 180°; không đặt quân lên a9/i1 lúc xếp |
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
`OTT_PLAYHTML_HOST` — endpoint self-hosted dành cho adapter; không đặt secret trong frontend.
`OTT_PLAYHTML_CONTROL_ENDPOINT` — HTTPS Worker control endpoint for create/list/join/resume; bỏ trống thì online unavailable.

## Online qua Cloudflare Worker

Kiến trúc online production duy nhất được cấu hình là Cloudflare Worker + Durable Objects trong `apps/worker/wrangler.jsonc`. PartyKit legacy không còn là route deploy hoặc authority online. Các file `partykit/` và test tương ứng được giữ lại như tài liệu/coverage legacy cho các ràng buộc bảo mật, không được dùng để deploy production.

Worker local/deploy commands:

```bash
npx wrangler dev --config apps/worker/wrangler.jsonc
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Local demo dùng minimal browser fork trong `vendor/playhtml-minimal/browser/`: một YProvider kết nối Worker, chờ initial sync rồi gửi các lệnh `ott:*` qua custom-message channel. Playwright đã xác nhận hai browser context có thể tạo/tham gia phòng và đồng bộ một nước đi hợp lệ. Đây không phải full upstream PlayHTML bundle.

Không dùng public PlayHTML host cho dữ liệu ván và không tạo WebSocket thứ hai. Static server chỉ phục vụ file tĩnh; authority online thuộc worker. Local và AI không phụ thuộc worker.

React session adapters chỉ render snapshot authoritative hoặc local session state.
Không ghi state ván online bằng PlayHTML shared page/element data, `can-play`,
event, presence, cursor hoặc awareness. Không thêm polling, WebSocket thứ hai,
fake factory hay fallback transport; `OTT_PLAYHTML_CONNECTION_FACTORY` là seam
tích hợp duy nhất khi runtime còn blocked.

Trạng thái production rollout: **BLOCKED**. Local demo path có runtime/two-browser evidence, nhưng Task 8 runtime/security matrix, Task 10 manual acceptance và deploy verification còn lại. Không suy rộng local demo thành production readiness. Local và AI modes vẫn hoạt động độc lập.

**Còn lại trước production:** hoàn tất runtime/security/lifecycle matrix, manual acceptance (bao gồm timeout/reconnect/expiry và credential isolation), kiểm tra deploy và chỉ cập nhật status theo evidence đã thực sự thu được. Các mục này không cần để chạy demo local hai người.
