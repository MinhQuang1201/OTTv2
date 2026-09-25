Kế Hoạch Đồng Bộ Logic OTTv2 Với Rule.md
Trạng thái: Chỉ lập kế hoạch. Plan Mode đang bật nên tôi không tạo/sửa file Markdown trong workspace. Khi được phép thực thi, lưu nguyên kế hoạch này tại docs/superpowers/plans/2026-09-25-rule-md-logic-alignment.md.
Mục tiêu: Đồng bộ toàn bộ logic game, server referee, AI, giao diện và kiểm thử với Rule.md: một quân mỗi ô, cùng loại khác phe bị chặn, mục tiêu A9/I1, thắng do loại toàn bộ quân hoặc làm đối phương hết nước đi.
Kiến trúc: rules.js là nguồn luật duy nhất cho local, AI và online. config.js chỉ chứa hằng số bàn/đội hình. room.js và server.js chỉ quản lý phiên/phòng và phát trạng thái do engine quyết định. game.js chỉ hiển thị và gửi nước đi, không tự quyết thắng thua.
Công nghệ: Node.js 18+, JavaScript CommonJS/UMD, node:test, WebSocket ws.
Phạm vi file
File	Trách nhiệm thay đổi
config.js	Ô thắng chính xác và chú thích đội hình ban đầu
rules.js	Luật di chuyển, một quân một ô, giao chiến, kết thúc ván
ai.js	Bỏ điểm thưởng xếp chồng; dùng trạng thái thắng mới
room.js	Chỉ coi winner là trạng thái kết thúc
server.js	Broadcast kết quả mới, bỏ payload draw/wipeType
game.js	Tọa độ hiển thị, một quân trên ô, thông báo kết quả mới
tests/rules.test.js	Test luật đơn vị đầy đủ theo Rule.md
tests/room.test.js	Test integration Room.handleMove
Rule.md	Không sửa trong kế hoạch này; đã là đặc tả nguồn
Không sửa CSS, HTML hay tài liệu khác trừ khi quá trình thực thi phát hiện chúng đang hiển thị dữ liệu luật sai.
Hợp đồng trạng thái mục tiêu
Chuẩn hóa lý do kết thúc ván:
reason	Khi nào	winner
goal	Quân vừa đi vào ô thắng của chính phe	Người vừa đi
elimination	Một phe không còn quân nào trên bàn	Phe còn quân
no_moves	Phe kế tiếp không có nước đi hợp lệ	Người vừa đi
disconnect	Người chơi rời phòng khi ván đang diễn ra	Người còn lại
Loại bỏ hoàn toàn:
reason: "wipe"
wipeType
wipeVictim
reason: "draw"
Event stack
Trạng thái có từ hai quân trở lên trên một ô.
Giữ countByType() chỉ để hiển thị số quân từng loại trên UI; không dùng nó quyết định thắng thua.
Task 1: Viết Test Luật Mới Trước
Files:
Modify: tests/rules.test.js
Reference: Rule.md mục 2, 4, 5, 8, 9, 10, 11, 12
1.1. Cập nhật test đội hình và tọa độ
Thay test setup hiện tại bằng kiểm tra đúng 9 quân A ở:
- A3 Lá, B3 Đấm, C3 Kéo
- A4 Đấm, B4 Kéo, C4 Lá
- A5 Kéo, B5 Lá, C5 Đấm
Kiểm tra B là ảnh xoay 180 độ của A và giữ nguyên loại quân.
Kiểm tra GOAL.A === a9, GOAL.B === i1.
Kiểm tra A9 và I1 trống.
Kiểm tra không quân nào có thể đi vào ô thắng của chính phe tại lượt đầu.
Đổi assertion hướng đội hình:
- A phải ở vùng x <= 2, y từ 2 đến 4.
- B phải ở vùng x >= 6, y từ 4 đến 6.
1.2. Cập nhật test di chuyển mở ván
Thay nước cũ i3 -> i2, vốn không còn hợp lệ theo đội hình mới.
Dùng nước A hợp lệ, ví dụ c3 -> d2.
Dùng nước xa không hợp lệ, ví dụ c3 -> c1.
Giữ test sai lượt, ra ngoài bàn, đứng yên và đi quá một ô.
1.3. Thay toàn bộ test xếp chồng
Xóa test “stacks same types on one square”.
Xóa test “lets a stacked piece step off”.
Thêm test: A Đấm ở E5, B Đấm ở F5; A đi E5 -> F5 phải bị từ chối.
Assert:
- result.ok === false.
- result.state === null.
- result.events rỗng.
- State đầu vào không đổi.
- Lượt vẫn là A.
- Mỗi ô vẫn chỉ có một quân.
Thêm test getLegalMoves() không trả về ô có quân đối phương cùng loại.
1.4. Bổ sung invariant một quân trên một ô
Tạo helper test nội bộ assertSingleOccupancy(state).
Helper tạo khóa ${piece.x},${piece.y} và assert không có khóa trùng.
Gọi helper sau:
- Di chuyển vào ô trống.
- Ăn thắng.
- Đòn thua.
- Cố đi vào quân khác phe cùng loại.
1.5. Cập nhật test điều kiện thắng
Giữ fixture A8 -> A9; assert A thắng với reason === "goal".
Giữ fixture I2 -> I1; assert B thắng với reason === "goal".
Giữ test quân A đứng tại I1 không thắng.
Sửa test “mất một loại”:
- B mất toàn bộ một loại nhưng còn quân loại khác.
- Assert winner === null.
- Assert lượt chuyển sang B.
Sửa test “ăn quân cuối”:
- A ăn quân B duy nhất.
- Assert winner === "A".
- Assert reason === "elimination".
- Assert không còn quân B.
Thêm test ngược:
- A thực hiện đòn thua và đó là quân A cuối cùng.
- Assert B thắng với reason === "elimination".
1.6. Bổ sung test ưu tiên điều kiện thắng
Tạo nước đi hợp lệ vừa đưa A vào A9 vừa loại quân cuối cùng của B.
Assert:
- A thắng.
- reason === "goal".
- Không trả về elimination.
1.7. Bổ sung test hết nước đi
Tạo fixture sau nước A hợp lệ:
- B Đấm ở A1.
- A Đấm ở A2, B1, B2 để B bị chặn bởi các quân khác phe cùng loại.
- Một quân A khác di chuyển hợp lệ, ví dụ C3 -> D3.
Assert sau nước đi:
- B vẫn còn quân.
- B không có nước hợp lệ.
- A thắng.
- reason === "no_moves".
- Không đổi turn sang B và không có draw.
Thêm test ván kết thúc không nhận thêm nước đi cho cả ba lý do: goal, elimination, no_moves.
1.8. Chạy test để thấy lỗi trước khi sửa engine
rtk test node --test tests/rules.test.js
Kỳ vọng: thất bại tại test ô thắng, loại toàn bộ quân, chặn quân cùng loại, không xếp chồng, và không còn nước đi.
Task 2: Sửa Hằng Số Bàn Cờ
Files:
Modify: config.js
Test: tests/rules.test.js
2.1. Sửa tọa độ ô thắng
Đổi:
const GOAL = { A: { x: 0, y: 0 }, B: { x: 8, y: 8 } };
Thành:
const GOAL = { A: { x: 0, y: 8 }, B: { x: 8, y: 0 } };
2.2. Sửa chú thích setup
Cập nhật chú thích đang nhắc a1.
Ghi rõ A bắt đầu tại A3:C5, mục tiêu A là A9.
Không thay A_SETUP: đội hình hiện có đã khớp bảng trong Rule.md.
Không thay công thức xoay 180 độ của B.
2.3. Chạy test setup và goal
rtk test node --test tests/rules.test.js
Kỳ vọng: test mục tiêu và đội hình qua, các test liên quan xếp chồng/type wipe/no move vẫn chưa qua.
2.4. Commit
rtk git add config.js tests/rules.test.js
rtk git commit -m "test: define canonical board setup and goals"
Task 3: Sửa Engine Luật Thuần
Files:
Modify: rules.js
Test: tests/rules.test.js
3.1. Cập nhật getLegalMoves
Giữ loại trừ ô có quân cùng phe.
Loại trừ thêm ô có quân đối phương cùng loại với quân đang đi.
Mọi ô còn lại trong 8 hướng là nước đi hợp lệ:
- Ô trống.
- Ô có quân khác phe khác loại.
Mẫu logic mục tiêu:
const occ = piecesAt(state, x, y);
if (occ.some((p) => p.player === piece.player)) continue;
if (occ.some((p) => p.player !== piece.player && p.type === piece.type)) continue;
moves.push({ x, y });
3.2. Bỏ nhánh xếp chồng trong applyMove
Sau khi tìm enemy, nếu compare(mover.type, enemy.type) === "tie", trả lỗi ngay.
Dùng thông báo nhất quán, ví dụ:
return fail("Không được đi vào ô có quân đối phương cùng loại");
Không di chuyển quân đi.
Không loại quân.
Không chuyển lượt.
Không phát event.
3.3. Bảo vệ invariant một quân một ô
Sau khi tìm occupants ở ô đích, nếu có trên một occupant, từ chối nước đi bằng lỗi trạng thái không hợp lệ.
Không tự chọn enemies[0] trong trạng thái nhiều quân.
Không cần thêm cơ chế phục hồi hay tương thích với state xếp chồng cũ.
Mẫu logic mục tiêu:
if (occupants.length > 1) {
  return fail("Trạng thái bàn cờ không hợp lệ");
}
3.4. Thay detectWinner bằng loại toàn bộ quân
Giữ kiểm tra ô thắng trước.
Bỏ vòng countByType() và TYPES.
Đếm tổng số quân từng ghế.
Nếu A không còn quân: B thắng elimination.
Nếu B không còn quân: A thắng elimination.
Bỏ wipeType, wipeVictim khỏi state clone/create/event payload.
Mẫu kết quả:
return {
  winner: other,
  reason: "elimination"
};
3.5. Thay skip/draw bằng thua do không có nước đi
Sau một nước hợp lệ, gọi detectWinner(next) trước.
Nếu đã có winner, set terminal state và event win.
Nếu chưa có:
- Xác định nextTurn.
- Nếu allMoves(next, nextTurn).length === 0, người vừa đi thắng.
- Đặt reason = "no_moves".
- Không chuyển lượt.
- Emit event win.
Nếu có nước đi, đặt next.turn = nextTurn.
Xóa toàn bộ branch tạo reason: "draw" hoặc tự bỏ lượt.
Mẫu logic mục tiêu:
const nextTurn = player === "A" ? "B" : "A";
if (allMoves(next, nextTurn).length === 0) {
  next.winner = player;
  next.reason = "no_moves";
  events.push({ type: "win", winner: player, reason: "no_moves" });
} else {
  next.turn = nextTurn;
}
3.6. Chạy test logic
rtk test node --test tests/rules.test.js
Kỳ vọng: tất cả test trong tests/rules.test.js pass.
3.7. Commit
rtk git add rules.js tests/rules.test.js
rtk git commit -m "feat: enforce one-piece board rules"
Task 4: Đồng Bộ Room Và Server
Files:
Modify: room.js
Modify: server.js
Modify: tests/room.test.js
Test: tests/room.test.js
4.1. Sửa terminal state trong Room.handleMove
Thay:
if (this.state.winner || this.state.reason === "draw") this.status = "done";
Thành:
if (this.state.winner) this.status = "done";
Không thêm luật di chuyển, chiến đấu hoặc kiểm tra thắng vào room.js.
4.2. Sửa game-over broadcast trong server.js
Chỉ broadcast gameover khi room.state.winner.
Bỏ điều kiện reason === "draw".
Bỏ wipeType khỏi message.
Message vẫn gửi winner và reason, bao gồm goal, elimination, no_moves, disconnect.
Mẫu payload:
room.broadcast({
  type: "gameover",
  winner: room.state.winner,
  reason: room.state.reason
});
4.3. Viết test Room theo luật mới
Test cùng loại khác phe bị Room.handleMove từ chối, state và turn giữ nguyên.
Test A đi A8 -> A9 làm room.status === "done".
Test B đi I2 -> I1 làm room.status === "done".
Test mất một loại nhưng còn quân không kết thúc room.
Test ăn quân cuối cùng kết thúc room với elimination.
Test đối phương không còn nước đi kết thúc room với no_moves.
Test không tạo state draw.
4.4. Chạy test Room
rtk test node --test tests/room.test.js
Kỳ vọng: tất cả room test pass.
4.5. Commit
rtk git add room.js server.js tests/room.test.js
rtk git commit -m "feat: propagate terminal game outcomes through rooms"
Task 5: Đồng Bộ AI
Files:
Modify: ai.js
Test: tests/rules.test.js
5.1. Xóa điểm thưởng xếp chồng
Xóa:
if (ev.type === "stack") score += 4;
Không thêm logic lọc cùng loại tại AI, vì rules.allMoves() đã là nguồn hợp lệ duy nhất.
5.2. Kiểm tra no-move
Giữ chooseMove(...) === null khi không có nước.
Không tự tạo winner trong AI.
Engine phải kết thúc ván trước khi AI được gọi khi phe đến lượt không có nước.
5.3. Chạy test luật và syntax
rtk test node --test tests/rules.test.js
rtk err node --check ai.js
Kỳ vọng: pass, không lỗi cú pháp.
5.4. Commit
rtk git add ai.js
rtk git commit -m "fix: align AI scoring with single-occupancy rules"
Task 6: Đồng Bộ UI Với State Engine
Files:
Modify: game.js
Reference: config.js, rules.js
6.1. Sửa tọa độ hiển thị
buildChrome() và renderBoard() phải hiển thị rank 1 -> 9 từ trên xuống, đúng Rule.md.
Đổi loop:
for (let y = config.SIZE - 1; y >= 0; y -= 1)
Thành:
for (let y = 0; y < config.SIZE; y += 1)
Đảm bảo labels hàng và ô render dùng cùng hướng.
6.2. Sửa đánh dấu ô thắng
Đổi goal-a từ (0, 0) sang (0, 8).
Đổi goal-b từ (8, 8) sang (8, 0).
Ưu tiên đọc trực tiếp từ config.GOAL, không hard-code lại:
if (x === config.GOAL.A.x && y === config.GOAL.A.y) btn.classList.add("goal-a");
if (x === config.GOAL.B.x && y === config.GOAL.B.y) btn.classList.add("goal-b");
6.3. Hiển thị đúng một quân trên ô
Thay occ.forEach(...) bằng render occ[0].
Không hỗ trợ nhiều token trong một .cell.
Có thể giữ wrapper CSS .stack để tránh sửa CSS trong phạm vi này, nhưng đổi tên thành .piece-wrap chỉ khi CSS hiện có không bị ảnh hưởng.
6.4. Bỏ event xếp chồng
Xóa ev.type === "stack" khỏi burst animation.
Chỉ animate capture và strike_loss.
6.5. Sửa thông báo kết thúc
goal:
- A: “Đưa quân vào ô thắng A9.”
- B: “Đưa quân vào ô thắng I1.”
elimination: “Đối phương không còn quân trên bàn.”
no_moves: “Đối thủ không còn nước đi hợp lệ.”
Giữ disconnect.
Bỏ wipe và draw.
6.6. Bỏ các nhánh draw
Trong openWin, chỉ mở modal khi state.winner.
Trong applyLocal, chỉ check app.state.winner.
Trong listener state, chỉ check app.state.winner.
Trong listener gameover, bỏ gán wipeType.
6.7. Kiểm tra AI không làm UI treo
playAi() chỉ nên chạy khi game chưa có winner.
Nếu chooseMove() trả null, không tự xử lý thắng thua trong UI; đây là invariant mà rules.applyMove phải đã xử lý sau nước trước đó.
Nếu gặp null trong trạng thái chưa terminal, hiển thị lỗi phát triển hoặc log cảnh báo, không âm thầm giữ game ở trạng thái kẹt.
6.8. Kiểm tra syntax
rtk err node --check game.js
Kỳ vọng: không lỗi.
6.9. Commit
rtk git add game.js
rtk git commit -m "fix: render canonical goals and terminal states"
Task 7: Kiểm Tra Toàn Bộ Hệ Thống
Files:
Không sửa file mới trừ khi verification phát hiện lỗi trực tiếp.
7.1. Chạy kiểm tra cú pháp
rtk err node --check config.js
rtk err node --check rules.js
rtk err node --check room.js
rtk err node --check server.js
rtk err node --check ai.js
rtk err node --check game.js
Kỳ vọng: không lỗi cú pháp.
7.2. Chạy toàn bộ test
rtk npm test
Kỳ vọng: toàn bộ test pass, không còn assertion về stack, wipe, wipeType, draw, a1 hoặc i9 với vai trò ô thắng.
7.3. Quét dấu vết luật cũ
rtk grep "stack|wipeType|wipeVictim|reason === \"draw\"|reason === \"wipe\"|a1|i9" -g "!node_modules" .
Kỳ vọng: không còn code logic/UI/test tham chiếu luật cũ. Các kết quả thuộc tài liệu lịch sử hoặc nội dung không liên quan phải được kiểm tra thủ công trước khi xóa.
7.4. Smoke test server
rtk npm start
Mở hai trình duyệt hoặc hai tab.
Tạo phòng và vào phòng.
Xác nhận A đi trước.
Xác nhận ô thắng hiển thị A9/I1.
Xác nhận thử đi vào quân đối phương cùng loại bị từ chối.
Xác nhận UI không hiển thị hai quân trên một ô.
Xác nhận kết thúc ván hiển thị đúng thông báo cho goal, elimination, no_moves.
7.5. Commit kiểm tra cuối, nếu cần
rtk git status
rtk git diff
Chỉ tạo commit nếu còn thay đổi có chủ đích sau các task trước.
Phân Chia Cho Luna
Luna có thể thực hiện theo thứ tự phụ thuộc sau:
1. Luna 1: Task 1, viết/cập nhật toàn bộ test fail theo Rule.md.
2. Luna 2: Task 2 và Task 3, sửa config.js và rules.js để pass test luật.
3. Luna 3: Task 4, đồng bộ room.js, server.js, và room tests.
4. Luna 4: Task 5 và Task 6, đồng bộ AI/UI sau khi engine ổn định.
5. Luna 5: Task 7, chạy toàn bộ test, syntax, quét luật cũ và smoke test.
Tasks 1, 2, 3 là chuỗi bắt buộc. Task 4 và Task 5/6 có thể chạy song song sau khi Task 3 hoàn tất.
