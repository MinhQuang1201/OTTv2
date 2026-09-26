# Handoff: PlayHTML browser runtime Tasks 6–7

Ngày: 2026-09-26 (Asia/Bangkok)

## Mục tiêu và trạng thái

Hoàn thiện demo local: hai browser context tạo/tham gia cùng phòng, attach qua một YProvider mỗi browser và chơi một nước hợp lệ đồng bộ qua Worker.

Task 6 và đường demo Task 7 đã có bằng chứng PASS. Chưa commit. Workspace có nhiều thay đổi user-owned từ các lượt trước; không reset/revert hoặc dọn các file ngoài scope.

## Đã làm

- Thêm runtime browser tối thiểu dưới `vendor/playhtml-minimal/browser/`, dùng public `y-partyserver@2.2.0` YProvider/custom-message API, chờ initial Yjs sync, tắt BroadcastChannel, một provider cho canonical room.
- Build bundle qua `npm run build:playhtml-browser`; HTML nạp runtime trước bootstrap/client. Bootstrap từ chối đổi room trên cùng provider.
- Thêm dependencies/scripts: `partyserver@0.5.10`, `y-partyserver@2.2.0`, `yjs@13.6.18`, Playwright `1.60.0` và `test:browser-worker-runtime`.
- Browser test/fixture khởi động Wrangler demo HTTPS và static app, hai context biệt lập, capture/sanitize frame summaries, xác nhận một WS mỗi context, không polling HTTP sau attach và không endpoint collaboration phụ.
- Sửa bug phát hiện bởi browser test: `ott:move`/`ott:leave` thiếu `roomId`; Worker bỏ qua nước đi. Client giờ gửi current room ID; đã thêm regression test.
- Sửa UI client lấy bootstrap runtime động, không resume đua với attach, unwrap projection và chuyển màn bàn chơi khi nhận state.
- Fixture hiện có `restartWorker()` dùng lại persistence path. Chưa có test nào gọi restart này; demo scope không yêu cầu reconnect/restart.
- Cập nhật `docs/playhtml-upstream-lock.md` và `vendor/playhtml-minimal/NOTICE.md` với gate/evidence/hashes, giữ rõ production chưa được tuyên bố ready.

## Kiểm chứng đã chạy

- `npm.cmd run test:browser-worker-runtime` — PASS hai lần; lần cuối: 1 test PASS, thời lượng khoảng 7.9s. Tạo phòng A, B join, hai attach và nước đi hiển thị ở B.
- `node --test tests/playhtml-custom-channel.test.js tests/playhtml-bootstrap.test.js tests/playhtml-game-client.test.js tests/worker-entry.test.js` — PASS 32/32.
- `npm.cmd run test:worker-runtime` — rerun độc lập PASS 6; giữ một skip có chủ ý cho acceptance thủ công Task 10.
- `git diff --check` — exit 0.
- `npm.cmd test` chưa có kết quả sạch: Worker runtime test trong full suite không lên ở cổng 8787 và readiness hết hạn. `node --test --test-concurrency=1 tests/*.test.js` cũng gặp lỗi tương tự ở runtime case 131; lần chạy bị dừng sau đó. Không kết luận nguyên nhân chỉ là tranh cổng. Ngay sau đó, `npm.cmd run test:worker-runtime` chạy độc lập lại PASS 6. Không coi full suite là PASS; lỗi có vẻ nằm ở cách full test runner khởi động Wrangler, chưa ảnh hưởng bằng chứng browser test.

## Việc tiếp theo

1. Điều tra vì sao Worker suite không khởi động trong full `npm test`/`node --test --test-concurrency=1`; isolated `npm.cmd run test:worker-runtime` lại PASS. Nếu tìm được sửa lỗi tối thiểu thì chạy full suite tuần tự.
2. Browser smoke đang xanh; chạy lại nếu có thay đổi ảnh hưởng browser harness/runtime.
3. Kiểm tra `git diff --check` sau chỉnh sửa và cập nhật file này nếu handoff cần chuyển tiếp.
4. Chưa làm Task 8 security/lifecycle matrix đầy đủ hoặc Task 10 manual acceptance/deploy; không tuyên bố production-ready. User chỉ chấp thuận demo hai browser tạo/tham gia/chơi nước đi, không yêu cầu timeout/reconnect/expiry.
5. Không commit nếu chưa được yêu cầu; giữ nguyên toàn bộ thay đổi user-owned khác.

## Files trọng tâm

- Browser runtime: `vendor/playhtml-minimal/browser/runtime-entry.js`, `runtime.js`, `index.js`
- Bootstrap/UI: `playhtml-bootstrap.js`, `playhtml-game-client.js`, `game.js`, `index.html`, `playhtml-game.html`
- Browser harness: `tests/browser-worker-runtime.test.js`, `tests/worker-runtime/fixture.js`, `scripts/run-browser-worker-runtime.js`
- Evidence/license: `docs/playhtml-upstream-lock.md`, `vendor/playhtml-minimal/NOTICE.md`

Quota tracker trả `tokensUsed: 435879`, nhưng không trả tổng quota hoặc `remainingTokens`; không thể tính chính xác phần trăm còn lại.
