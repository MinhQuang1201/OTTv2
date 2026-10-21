# PROJECT_OVERVIEW — OTTv2

> Tài liệu rà soát toàn dự án, mô tả **trạng thái code hiện tại** trên nhánh `feat/ai-minimax`
> (commit `7181c92`, ngày rà soát 2026-10-21). Mọi kết luận đều dựa trên việc đọc code và
> chạy lệnh trong máy local. Mức tin cậy được ghi rõ: **Confirmed** (có bằng chứng),
> **Potential** (có nguy cơ, chưa đủ bằng chứng), **Not verified** (chưa kiểm tra được).
> Các mục §1–§15 mô tả trạng thái **lúc rà soát**; xem bảng ngay dưới cho những gì đã sửa sau đó.

### Cập nhật sau rà soát

| Mục | Thay đổi | Kiểm chứng |
|---|---|---|
| H1 | `draft/run` trả 403 `SOURCE_SUBMISSION_DISABLED` cho non-admin khi draft service chạy `trusted-process` (`bots.mjs`, `draftService.trustedLocalMode`) | Test mới: author → 403, admin → 200 |
| M1, M2 | `Room.resumePlayer`/`addPlayer` và `restoreLiveConnection` không chạy đồng hồ của ghế tới lượt khi ghế đó đang mất kết nối | 2 test mới trong `tests/room.test.js`; script tái hiện không còn lỗi |
| M3 | `publishPublicSummary` chiếu đồng hồ tới `now` mà không gọi `settleClock` trên Room | typecheck worker + unit pass |
| M5 | Gỡ `partykit`, `playhtml` khỏi `dependencies` | `npm audit --omit=dev`: 0 lỗ hổng (trước: 5); toàn bộ: 10 (trước: 12) |
| L3, L4 | README: Node 22, cổng Vite 5173; `$schema` của wrangler test configs | — |

Sau khi sửa: build ✅, typecheck web/worker ✅, unit 1007/1007 ✅, web 710/710 ✅, arena 428/428 ✅,
integration 6 pass / 7 skipped (như trước). Còn mở: M4 (cần chủ dự án chốt trạng thái rollout và origin),
L1, L2, L5–L8, nâng cấp `vitest`/`vite`/`wrangler`.

---

## 1. Project Summary

OTTv2 ("Oẳn Tù Tì v2") là trò chơi cờ chiến thuật hai người trên bàn 9×9. Mỗi bên có 10 quân
(3 Đấm, 4 Lá, 3 Kéo), đi 1 ô theo 8 hướng, ăn theo vòng Đấm > Kéo > Lá > Đấm. Thắng khi đưa quân
vào ô thắng của mình (A: a1, B: i9), ăn hết quân đối phương, đối phương không còn nước đi, hoặc
đối phương hết giờ (10 phút/ghế).

Repository thực tế gồm **ba khối lớn**, lớn hơn đáng kể so với mô tả trong `CLAUDE.md`:

| Khối | Vai trò | Trạng thái |
|---|---|---|
| Game cốt lõi + Web | Luật thuần, Room/trọng tài, AI minimax, React UI (local, AI, demo, replay) | Đã triển khai, test pass |
| Online (Cloudflare Worker + Durable Objects) | Phòng chơi online server-authoritative qua PartyServer/Yjs + lệnh `ott:*`, lobby, khán giả, giải đấu người chơi | Đã triển khai; có pipeline deploy; trạng thái production **mâu thuẫn trong tài liệu** (xem §11, §12) |
| Arena (bot platform, Node + SQLite) | Người dùng nộp bot (JS/Python/Java/C++), build, chạy trận bot-vs-bot, Elo, giải đấu, replay, competition | Đã triển khai phần lớn; chạy local/loopback; có lỗ hổng phân quyền (xem §12-H1) |

Quy mô: ~540 file được git track, ~183k dòng (bao gồm fixture/lockfile). Mã nguồn chính
(không tính test/vendor): `apps/web/src` ~40k dòng, `packages/arena-node` ~12k, `packages/arena` ~6.8k,
`apps/worker/src` ~4.8k, `apps/arena-api` ~3.5k, `packages/game-core` ~1.1k.

## 2. Project Goals & Scope

Mục tiêu (rút ra từ code, `Rule.md`, `README.md`, `CLAUDE.md`):

- Cài đặt luật chơi chính xác, thuần (không I/O), dùng chung cho mọi chế độ (`packages/game-core`).
- Chơi local hai người một máy và chơi với máy (AI chạy trong Web Worker).
- Chơi online với server là trọng tài duy nhất (client chỉ gửi lệnh, vẽ snapshot).
- Chế độ khán giả (spectator) read-only và danh sách trận công khai.
- Arena: nền tảng cho bot do người dùng viết thi đấu, có cách ly thực thi (container) cho mã không tin cậy.

Ngoài phạm vi / chưa có: chat (chỉ có `apps/web/src/features/chat/README.md`, không có code và
protocol không có lệnh chat), tài khoản người chơi cho chế độ online (online dùng capability token,
không có đăng nhập).

## 3. Technology Stack

| Lớp | Công nghệ (phiên bản pin trong `package.json`) |
|---|---|
| Runtime | Node.js ≥ 22 (`.nvmrc` = 22; môi trường rà soát: v22.14.0, npm 10.9.2) |
| Game core | JavaScript UMD/CommonJS thuần (chạy được cả Node lẫn browser qua `globalThis`) |
| Frontend | React 18.3.1, TypeScript 5.7.3, Vite 5.4.14, CSS Modules, Web Worker cho AI |
| Test frontend | Vitest 2.1.8, Testing Library, jsdom 24 |
| Test backend | `node:test` (runner tự viết `scripts/run-node-tests.js`), Playwright 1.60 (e2e) |
| Online | Cloudflare Workers + Durable Objects (SQLite-backed), `partyserver` 0.5.10, `y-partyserver` 2.2.0, `yjs` 13.6.18, Wrangler 4.141.0 |
| Client online | Bản fork tối giản PlayHTML trong `vendor/playhtml-minimal/browser/` (bundle bằng esbuild) |
| Arena | Node HTTP thuần (`node:http`), `better-sqlite3` 11.10.0, scrypt cho mật khẩu, Docker/OCI (Alpine) cho cách ly bot |
| Static server | `server.js` — `node:http` thuần, `dotenv` |
| CI/CD | GitHub Actions (`ci.yml`, `deploy.yml`), Cloudflare (Worker), Vercel (frontend) |

Dependency khai báo nhưng **không có source nào import**: `partykit` 0.0.115, `playhtml` 2.15.0 (Confirmed bằng `git grep`; xem §12-M5).

## 4. Project Structure

```
packages/
  game-core/src/      config.js, rules.js (luật thuần), room.js (Room/trọng tài, đồng hồ, reconnect), ai.js (minimax)
  protocol/src/       Hợp đồng lệnh/phản hồi ott:* (parse/validate, giới hạn payload, alias)
  game-client/src/    Adapter lệnh ott:* phía browser + bootstrap PlayHTML
  arena/src/          Domain Arena: ruleset, maps, Elo, round-robin, Swiss, match-controller, replay, contracts/validation
  arena-node/src/     Hạ tầng Arena: SQLite repositories + migrations, job queue/worker, build service,
                      process-bot, container-executor, artifact store, live frames
apps/
  web/                React app (Vite): features/ (lobby, game, result, replay, spectator, tournaments, arena),
                      sessions/ (local, ai, demo, online, spectator, replay), shared/ (theme, ui, model, audio)
  worker/             Cloudflare Worker: entry/, game/ (OttGameServer DO), lobby/ (OttLobbyServer, stream, tournament),
                      auth/ (HMAC capability, internal secret), persistence/ (DurableRoomAdapter)
  arena-api/          HTTP API Arena (auth, bots, matches, tournaments, competitions, leaderboard)
  arena-cli/          CLI offline (doctor, match headless)
  arena-discovery/    Worker nhỏ lưu endpoint Arena (trycloudflare) cho frontend demo
partykit/             Mã "legacy" — nhưng partykit/room-storage.js VẪN được Worker import (serialize/hydrate Room)
vendor/playhtml-minimal/  Fork tối giản runtime PlayHTML cho browser
bots/, sdk/arena/     Bot mẫu và SDK/ví dụ (JS, Python, Java, C++)
ops/arena/            Dockerfile + image manifest cho sandbox bot
scripts/              Runner test, worker-dev, smoke-deploy, arena-demo, browser harness
tests/                71 file *.test.js (node:test) + fixtures; web có 51 file test riêng trong apps/web/src
docs/                 Hướng dẫn PlayHTML, evidence, plans/specs, rollback
server.js             Static server cho apps/web/dist
```

Ở thư mục gốc có ~20 file Markdown handoff/report lịch sử (HANDOFF*.md, PROGRESS_HANDOFF_*.md,
TEST_REPORT.md, IMPLEMENTATION_STATUS.md, …), nhiều nội dung đã lỗi thời hoặc mâu thuẫn nhau.

## 5. System Architecture

```
                  ┌────────────────────────── Browser (React, apps/web) ──────────────────────────┐
                  │ LobbyScreen ─► Session (contract.ts)                                          │
                  │   LocalSession ── gameCoreBridge ──► game-core rules.js (globalThis.OTT_RULES)│
                  │   AiSession ── ai.worker.ts (Web Worker) ──► game-core ai.js                  │
                  │   DemoSession / ReplaySession (fixtures, replay file)                         │
                  │   OnlineSession / SpectatorSession ── runtimeBridge ── vendor playhtml-minimal │
                  └──────────────┬──────────────────────────────────────┬────────────────────────┘
          HTTPS POST /control/<action> (CORS: OTT_BROWSER_ORIGIN)      WebSocket /parties/main/ott-<uuid>
                                 │                                       /parties/lobby/ott-lobby-public
                  ┌──────────────▼───────────── Cloudflare Worker (apps/worker) ────────────────────┐
                  │ ott-worker.ts: định tuyến, chặn path lạ (404)                                    │
                  │ OttLobbyServer DO (1 instance "lobby"): create/list/join/resume/spectate/invite, │
                  │   rate limit, alias, tournament coordinator, cấp capability HMAC                 │
                  │ OttGameServer DO (1/phòng, YServer read-only): ott:attach/move/leave/spectate,   │
                  │   DurableRoomAdapter ──► game-core Room ──► rules.applyMove; alarm cho đồng hồ   │
                  │ OttLobbyStreamServer DO: luồng danh sách trận công khai cho khán giả            │
                  └─────────────────────────────────────────────────────────────────────────────────┘

  Arena (độc lập, Node):  arena-api (HTTP, 127.0.0.1:3001) ─► SQLite (var/arena/arena.db)
                          └► JobWorker ─► process-bot (trusted) | container-executor (Docker) ─► game-core rules
```

Nguyên tắc kiến trúc được code tuân thủ (Confirmed bằng đọc code):

- Luật chỉ nằm ở `packages/game-core/src/rules.js`; Room, Worker, Arena và web session đều gọi lại nó
  (`node-engine.mjs` của Arena `require` chính `rules.js`/`config.js`).
- Online: `OttGameServer.isReadOnly()` trả `true`, `onSave()` rỗng → client không ghi được Yjs document;
  state ván chỉ đi qua lệnh `ott:*` và snapshot do server gửi.
- `server.js` chỉ phục vụ file tĩnh từ `apps/web/dist`, không có WebSocket hay luật.

## 6. Core Features

| Chức năng | Trạng thái | Bằng chứng |
|---|---|---|
| Luật chơi (di chuyển, ăn, đòn thua bị từ chối, ô thắng, tuyệt chủng, no_moves, timeout) | Đã triển khai — Confirmed | `rules.js`; `tests/rules.test.js`, `tests/rules-fuzz.test.js` pass |
| Room: ghế A/B, đồng hồ server-authoritative, grace reconnect 60s, leave xử thua, chống trùng/stale revision | Đã triển khai — Confirmed; có lỗi đồng hồ ở case biên (§12-M1, M2) | `room.js`; `tests/room.test.js` pass; script tái hiện |
| Hai người một máy | Đã triển khai — Confirmed (test) | `sessions/local/LocalSession.ts` + test |
| Chơi với máy (easy/medium/hard, Web Worker) | Đã triển khai — Confirmed (test) | `ai.js`, `sessions/ai/*`, `tests/ai.test.js` |
| Demo scenarios `?demo=…` | Đã triển khai — Confirmed (test) | `sessions/demo/*`, `ScenarioSwitcher` |
| Replay (import/xem/điều khiển/phím tắt, fork sang local/AI) | Đã triển khai — Confirmed (test) | `features/replay/*`, `sessions/replay/*` |
| Online tạo/vào/resume phòng, alias, invite | Đã triển khai — test unit/integration; production **Not verified** bởi lần rà soát này | `apps/worker/src/lobby`, `game` |
| Khán giả + danh sách trận công khai | Đã triển khai sau cờ `OTT_SPECTATOR_ENABLED` (đang `"true"` trong `wrangler.jsonc`) | `ott-lobby-stream-server.ts`, `SpectatorSession.ts` |
| Giải đấu người chơi (human tournament) | Đã triển khai (domain + coordinator + UI dialog) — Confirmed (test) | `packages/arena/src/domain/human-tournaments`, `tournament-coordinator.ts` |
| Arena: tài khoản, bot, version/build, trận, Elo, giải, competition/rounds, leaderboard, live frames, draft run | Đã triển khai — Confirmed (test); có lỗi phân quyền (§12-H1) | `apps/arena-api`, `packages/arena*` |
| Cách ly bot bằng container | Đã triển khai (Docker, non-root, Alpine pinned) — isolation suite **Not verified** ở lần này | `container-executor.mjs`, `ops/arena/Dockerfile` |
| Chat | **Chưa triển khai** (chỉ README) | `apps/web/src/features/chat/` |

## 7. Key Workflows

### 7.1 Một nước đi local/AI
1. `Board` → `useBoardSelection` → `session.move(from, to)`.
2. `LocalSession` gọi `bridge.applyMove(state, player, from, to)` → `rules.applyMove` trả `{ok, state, events}`.
3. Nước không hợp lệ (gồm đòn thua) → `ok:false`, state không đổi; nước hợp lệ → đổi lượt, kiểm tra
   thắng (goal → elimination → no_moves của đối phương).
4. Đồng hồ local: `setInterval` → `rules.elapseClock` → timeout.
5. AI: `AiSession` gửi state sang `ai.worker.ts`; `chooseMove` dùng iterative deepening + alpha-beta, giới
   hạn số nút (easy d1/2k, medium d2/20k, hard d4/100k).

### 7.2 Tạo và chơi phòng online
1. Browser `POST /control/create {name}` → Worker → `OttLobbyServer`: kiểm tra body (giới hạn byte, JSON),
   burst rate-limit 40 ms/action/IP, rate limiter Cloudflare 5 lần/phút cho create.
2. Lobby tạo `allocationId` (UUID), alias, owner credential, capability HMAC (`attach`, seat A), rồi gọi
   `OttGameServer /internal/initialize` với header `x-ott-internal-secret` + capability `game-init`.
3. Client mở WebSocket `/parties/main/ott-<uuid>`, gửi `ott:attach {ticket}`; Game DO xác minh capability,
   nonce chống replay, gắn ghế vào connection (serializeAttachment để sống qua hibernation).
4. Người thứ hai `join` → lobby cấp capability seat B → `ott:attach` → `Room.addPlayer` → status `playing`.
5. `ott:move {from,to,expectedRevision}` → `DurableRoomAdapter.move` → `Room.handleMove` → `rules.applyMove`
   → persist vào DO storage → broadcast `ott:state` (projection theo viewer) → cập nhật public summary.
6. Đồng hồ/grace: Room trong Worker không dùng timer (`schedule` rỗng); DO alarm gọi `adapter.onAlarm()`
   → `settleClock`/`expireReconnect`/`expireWaitingCreator`.
7. Kết thúc: Game DO gọi lobby `/internal/terminalize`; lỗi thì retry bằng alarm; sau `retentionMs`
   (mặc định 1 giờ) storage của Game DO bị xoá.

### 7.3 Arena
`POST /api/arena/v1/auth/login` (Bearer token, scrypt) → tạo bot → nộp version (chỉ admin khi
`trustedMode`) → build → job queue → JobWorker chạy trận (process hoặc container) → finalizer ghi kết
quả/Elo/replay → leaderboard/live frames.

## 8. Networking & Data Flow

| Kênh | Giao thức | Kiểm soát (Confirmed bằng code) |
|---|---|---|
| Control API | HTTPS `POST /control/<action>` | CORS chỉ cho `OTT_BROWSER_ORIGIN`; body ≤ `MAX_BODY`, đọc stream có giới hạn, UTF-8 fatal; rate limit 40 ms + 5/phút cho create |
| Game | WebSocket (y-partyserver) + custom message `ott:*` | Path regex chặt (`ott-<uuid>`); parse whitelist key; ≤ 8 KB; cách 40 ms/gói (gói vượt bị **bỏ im lặng**); tọa độ phải nằm trong bàn (`rules.inside` dùng `Number.isInteger`) |
| Nội bộ DO↔DO | `fetch` với `x-ott-internal-secret` | So sánh hằng thời gian; capability HMAC có `purpose`, `seat`, `expiresAt`, nonce lưu trong storage |
| Lobby stream | WebSocket `/parties/lobby/ott-lobby-public` | Chỉ mở khi `OTT_SPECTATOR_ENABLED === "true"` |
| Arena API | HTTP `127.0.0.1:3001` | CORS allowlist, body ≤ 1 MiB, Bearer token (cấm token trong query), role `author`/`admin` |
| Static | HTTP `0.0.0.0:3000` | Chặn `..`, symlink thoát ra ngoài, path private; chỉ GET/HEAD |

Đồng thời (concurrency) trong Game DO: mọi lệnh và sự kiện close được xếp hàng tuần tự
(`enqueueRoomOperation`); connection có "generation" để bỏ kết quả của socket đã bị thay thế.

## 9. Configuration & Environment Variables

| Biến | Nơi dùng | Ghi chú |
|---|---|---|
| `PORT` | `server.js`, `config.js`; **cũng là fallback của Arena API** (`apps/arena-api/src/config.mjs:55`) | Mặc định 3000 (static) / 3001 (Arena) |
| `OTT_WORKER_HOST`, `OTT_WORKER_PORT` | `config/local-runtime.js`, `scripts/worker-dev.js` | Chỉ cho phép loopback |
| `VITE_OTT_PLAYHTML_HOST`, `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT` | Build web | Để trống ⇒ online unavailable |
| `VITE_OTT_SPECTATOR_ENABLED`, `VITE_OTT_ARENA_API_ENDPOINT`, `VITE_OTT_ARENA_DISCOVERY_ENDPOINT` | Build web | Không có trong `.env.example` |
| `OTT_INTERNAL_SECRET` | Worker secret (`.dev.vars` local, `wrangler secret` khi deploy) | Thiếu ⇒ create/initialize trả 503/403 (fail-closed) |
| `OTT_BROWSER_ORIGIN`, `OTT_SPECTATOR_ENABLED` | `wrangler.jsonc` vars | CI ghi đè `OTT_BROWSER_ORIGIN` bằng `FRONTEND_URL` |
| `OTT_TEST_CLOCK_MS`, `OTT_TEST_RECONNECT_GRACE_MS`, `OTT_TEST_CREATOR_ATTACH_TTL_MS`, `OTT_TERMINAL_RETENTION_MS` | Env `test`/`demo` | Rút ngắn thời gian cho test |
| `ARENA_*` (`ALLOWED_ORIGINS`, `API_PORT`, `API_HOST`, `DB_PATH`, `STORAGE_DIR`, `MAX_BODY_BYTES`, `MAX_SOURCE_BYTES`, `EXTERNAL_WORKER`, `PUBLIC_REGISTRATION`, `LOCAL_DEMO_CONTAINERS`, `TRUSTED_MODE`) | Arena | `TRUSTED_MODE` mặc định `true` |
| `ARENA_DISCOVERY_WRITE_TOKEN` | arena-discovery Worker | Thiếu ⇒ PUT trả 503 |
| GitHub Environment: `WORKER_URL`, `FRONTEND_URL`, `CLOUDFLARE_*`, `VERCEL_*` | `deploy.yml` | Kiểm tra bắt buộc + HTTPS trước khi deploy |

File cấu hình: `.env.example`, `apps/worker/wrangler.jsonc` (+ `wrangler.test.jsonc`, `wrangler.spectator-test.jsonc`),
`apps/arena-discovery/wrangler.jsonc` (có `account_id` hard-code — không phải secret), `apps/web/vite.config.ts`,
`apps/web/vitest.config.ts`, hai `tsconfig.json`. Không phát hiện secret hard-code trong file được track.

## 10. Setup, Run, Build & Deployment

```bash
npm ci                     # Node 22
npm run build:web          # Vite → apps/web/dist (server.test.js cần bản build này)
npm start                  # static server :3000 phục vụ dist
npm run dev:web            # Vite dev server — cổng mặc định của Vite là 5173 (README ghi 3000, xem §12-L3)
npm run worker:dev         # wrangler dev --local (cần .dev.vars với OTT_INTERNAL_SECRET)
npm run arena:api          # Arena API 127.0.0.1:3001 (+ embedded JobWorker)
npm run arena:demo         # Arena ở chế độ container (ARENA_TRUSTED_MODE=false)
```

Deploy (`.github/workflows/deploy.yml`): push `main` → staging; tag `v*` → production; chạy lại workflow
trên tag cũ để rollback. Các bước: CI → `wrangler deploy` (ghi đè `OTT_BROWSER_ORIGIN`) → kiểm tra secret
`OTT_INTERNAL_SECRET` tồn tại → build web trỏ tới `WORKER_URL` → `vercel deploy` → `scripts/smoke-deploy.js`
→ ghi release notes. Arena **không** có pipeline deploy (chỉ chạy local/loopback, có thể công bố qua
tunnel trycloudflare theo thiết kế của `arena-discovery`).

## 11. Current Implementation Status

- **Đã triển khai & có test pass**: game-core, web (local/AI/demo/replay/spectator UI/arena UI), Worker
  (lobby/game/stream/tournament), Arena (API, persistence, queue, build, execution, Elo, giải, competition).
- **Triển khai một phần**: chat (chưa có code); Arena chỉ cho admin nộp source khi `trustedMode` (chờ
  "Task 19 isolation verification") — nhưng xem §12-H1.
- **Trạng thái rollout online — tài liệu mâu thuẫn (Confirmed)**:
  `CLAUDE.md` và `README.md` ghi "rollout BLOCKED, online unavailable"; trong khi `HANDOFF.md` (mục
  2026-09-30) ghi Worker và Vercel production đã deploy, spectator production **ENABLED**, và code/CI hiện
  có pipeline deploy production đầy đủ. Lần rà soát này **không truy cập** môi trường deploy nên không xác
  nhận được trạng thái production thực tế (**Not verified**).
- `HANDOFF.md` ghi "Tám test Node vẫn skip"; lần chạy này `npm run test:unit` báo 0 skipped, còn
  `npm run test:integration` báo 7 skipped (6 do thiếu `.dev.vars`, 1 manual) — các test skip nằm ở suite integration.

## 12. Known Issues & Risks

Xếp theo mức độ. Không phát hiện lỗi Critical được xác nhận.

### H1 — High — Confirmed: `draft/run` của Arena bỏ qua chặn `trustedMode`, cho tài khoản `author` chạy mã tuỳ ý trên host
- **Vị trí**: `apps/arena-api/src/routes/bots.mjs:190-201` (chặn chỉ ở `POST /bots/:id/versions`),
  `apps/arena-api/src/routes/bots.mjs:354-420` (`POST /bots/:id/draft/run` không có chặn tương tự),
  `packages/arena-node/src/execution/draft-service.mjs:163-164` (`trustedLocalMode` ⇒ `isolation = "trusted-process"`).
- **Điều kiện**: Arena API chạy cấu hình mặc định (`ARENA_TRUSTED_MODE` không đặt ⇒ `trustedMode=true`,
  `npm run arena:api`) và tồn tại một tài khoản không phải admin (tạo bởi admin, hoặc
  `ARENA_PUBLIC_REGISTRATION=true`). Tài khoản `author` tự tạo bot được (`POST /api/arena/v1/bots` không
  giới hạn role) rồi gọi `draft/run` với `source` bất kỳ.
- **Bằng chứng**: test hiện có `tests/arena-draft-live.test.js` (khối "4. HTTP API Endpoints", ~dòng 1350-1390)
  đăng nhập bằng token role `author`, server `trustedMode: true`, và **khẳng định** HTTP 200 với
  `isolation: "trusted-process"`. Thông điệp ở `bots.mjs:197` nói rõ chính sách là "admin-curated builds only
  until Task 19 isolation verification".
- **Ảnh hưởng**: thực thi mã tuỳ ý với quyền của tiến trình Node (đọc DB SQLite, file hệ thống, mạng).
  Nếu Arena được công bố ra Internet (thiết kế `arena-discovery` trỏ tới endpoint `*.trycloudflare.com`),
  đây là RCE từ xa cho bất kỳ ai có tài khoản author.
- **Khắc phục**: áp dụng cùng điều kiện `if (trustedMode && user.role !== "admin") → 403` cho `draft/run`
  (hoặc buộc `isolation = "container"` cho non-admin), và sửa test để khẳng định 403 cho author.

### M1 — Medium — Confirmed (mức Room): resume chạy đồng hồ của ghế vẫn đang mất kết nối
- **Vị trí**: `packages/game-core/src/room.js:358-362` (`resumePlayer` đặt `runningSeat = state.turn`
  không kiểm tra ghế đó có `connected`); mẫu tương tự ở `apps/worker/src/persistence/room-storage.ts:155-158`
  (`restoreLiveConnection`).
- **Điều kiện**: cả hai ghế mất kết nối, ghế **không** tới lượt kết nối lại trước.
- **Bằng chứng**: script tái hiện (scratchpad, chỉ đọc): sau khi A resume, `turn=B`, `B.connected=false`,
  `runningSeat=B`; 30 giây sau B bị trừ 30000 ms.
- **Ảnh hưởng**: vi phạm `Rule.md` §14.2 ("đồng hồ của người mất kết nối dừng"); ghế đang mất kết nối mất
  thời gian oan. So sánh: `handleMove` (room.js:267-269) đã xử lý đúng case này.
- **Khắc phục**: chỉ đặt `runningSeat` khi `this.players[this.state.turn]?.connected`; áp dụng tương tự
  trong `restoreLiveConnection`; thêm test tại `Room` cho kịch bản này.

### M2 — Medium — Confirmed (mức Room) / Potential (Worker): ván bắt đầu với đồng hồ của A chạy khi A đang mất kết nối
- **Vị trí**: `room.js:112-118` (`addPlayer` bật `playing` và chạy đồng hồ A mà không xét `players.A.connected`).
- **Bằng chứng**: tái hiện: A tạo phòng, mất kết nối (trong grace), B vào ⇒ `status=playing`,
  `A.connected=false`, `runningSeat=A`.
- **Worker**: `DurableRoomAdapter.attach` (room-storage.ts:385-389) không kiểm tra A còn kết nối; việc lobby
  có ngăn join trong tình huống này hay không **chưa được xác minh**.
- **Khắc phục**: khi đủ hai ghế, chỉ chạy đồng hồ nếu ghế tới lượt đang kết nối.

### M3 — Medium — Potential: đường đọc `publishPublicSummary` làm biến đổi Room trong bộ nhớ
- **Vị trí**: `apps/worker/src/game/ott-game-server.ts:705-711` gọi `room.settleClock(now, { commit: false })`.
- **Mô tả**: `settleClock` vẫn gán `this.state`, `clockAnchorMs` và, nếu hết giờ, gọi `finishTerminal()`
  (status `done`) — nhưng đường này không `persist()` và không broadcast. Room trong bộ nhớ có thể lệch
  với snapshot đã lưu cho tới khi alarm xử lý. Ngoài ra summary luôn ghi `status: "playing"` cứng.
- **Ảnh hưởng dự kiến**: thường tự hồi phục nhờ alarm (`onAlarm` thấy `done` và terminalize), nhưng storage
  `room` có thể vẫn là `playing` sau terminal. **Chưa tái hiện được** trong lần rà soát này.
- **Khắc phục**: tính summary từ bản sao (`rules.elapseClock` trên `cloneState`) thay vì mutate Room.

### M4 — Medium — Confirmed: tài liệu trạng thái/cấu hình mâu thuẫn
- `CLAUDE.md`, `README.md`: online "BLOCKED/unavailable"; `HANDOFF.md`: production đã deploy, spectator ENABLED;
  `deploy.yml` deploy production từ tag `v*`.
- `apps/worker/wrangler.jsonc` có `OTT_BROWSER_ORIGIN = https://ottv2-psi.vercel.app`, còn `HANDOFF.md`
  ghi alias production `https://ottv2-two.vercel.app`. CI ghi đè bằng `--var`, nhưng deploy thủ công theo
  README (`wrangler deploy --config apps/worker/wrangler.jsonc`) sẽ dùng giá trị trong file ⇒ CORS sai origin.
- **Ảnh hưởng**: người/agent bảo trì làm theo ràng buộc sai; deploy thủ công có thể làm hỏng CORS.
- **Khắc phục**: chọn một nguồn sự thật cho trạng thái rollout, cập nhật `CLAUDE.md`/`README.md`, đồng bộ origin.

### M5 — Medium — Confirmed: dependency không dùng kéo theo lỗ hổng; dev toolchain có advisory nghiêm trọng
- `partykit@0.0.115` và `playhtml@2.15.0` nằm trong `dependencies` nhưng không có import nào trong source/test
  (`git grep`). `npm audit --omit=dev`: **5** lỗ hổng (2 high: `undici`/`@fastify/busboy` qua `miniflare`;
  3 moderate: `esbuild`) — tất cả qua chuỗi `partykit`.
- `npm audit` toàn bộ: **12** (2 critical: `vitest`/`tinypool`; 7 high gồm `vite`, `wrangler`, `miniflare`,
  `undici`, `sharp`, `source-map-js`, `@fastify/busboy`; 3 moderate). Phần lớn là dev-only.
- **Khắc phục**: gỡ `partykit`/`playhtml` (sau khi chạy lại toàn bộ test), nâng `vitest`/`vite` theo advisory;
  không dùng `npm audit fix --force` mù quáng vì sẽ hạ `partykit` về `0.0.0`.

### L1 — Low — Confirmed: giới hạn/làm sạch tên người chơi không nhất quán
`room.js:5-13` cắt `NAME_MAX = 20` và bỏ `<`/`>` lẻ; `ott-lobby-server.ts:123-127` cắt 32 và chỉ bỏ thẻ
`<...>`; `ott-game-server.ts:168` cắt 32. Tên trong danh sách phòng chờ (≤32) khác tên trong ván (≤20).
React escape output nên **không** phát hiện XSS. Khắc phục: một hàm sanitize dùng chung.

### L2 — Low — Confirmed: throttle 40 ms bỏ gói im lặng và tự gia hạn
`ott-game-server.ts:224-227` cập nhật `lastOttPacketMs` cả khi gói bị bỏ, không gửi lỗi. Client gửi đều
< 40 ms bị bỏ toàn bộ; client hợp lệ gửi 2 lệnh sát nhau sẽ không nhận phản hồi cho lệnh thứ hai.
Khắc phục: chỉ cập nhật mốc khi gói được nhận, trả `ott:error rate_limited`.

### L3 — Low — Confirmed: README sai so với code
README "Cần Node.js 18 trở lên" (engines `>=22`); `npm run dev:web` rồi "mở http://localhost:3000"
trong khi `vite.config.ts` không đặt `server.port` (Vite mặc định 5173). Arena mặc định chỉ cho CORS
`:3000`, nên frontend chạy bằng `dev:web` (5173) gọi Arena sẽ bị chặn CORS (**Potential**, chưa thử).

### L4 — Low — Confirmed: `$schema` trỏ tới đường dẫn không tồn tại
`apps/worker/wrangler.test.jsonc:2`, `wrangler.spectator-test.jsonc:2` → `node_modules/playhtml/node_modules/wrangler/...` (không có). Chỉ ảnh hưởng gợi ý editor.

### L5 — Low — Confirmed: bundle lớn
`npm run build:web` cảnh báo `index-*.js` 661 kB (gzip 196 kB) > 500 kB; toàn bộ UI Arena được tải cho
mọi người chơi. Khắc phục: `React.lazy` cho route Arena/Replay.

### L6 — Low — Potential: Lobby là một Durable Object đơn
Mọi `/control/*` đi vào `idFromName("lobby")`; mỗi request còn `scheduleAlarm()` liệt kê toàn bộ key
`rate:last:*` (`ott-lobby-server.ts:262`). Ở tải cao đây là nút thắt. Chưa đo.

### L7 — Low — Potential: alias phòng sinh bằng `Math.random`
`packages/protocol/src/index.ts` `generateRandomAlias` dùng `Math.random`. Việc alias một mình có đủ để
chiếm ghế hay không (invite/claim) **chưa được xác minh**.

### L8 — Low — Confirmed: static server tối giản
`server.js` không đặt CSP/`X-Frame-Options`; HEAD trả cả body. Production frontend chạy trên Vercel nên
ảnh hưởng chủ yếu khi tự host bằng `npm start`.

## 13. Testing Status

Kết quả thực tế trong lần rà soát (Windows 11, Node 22.14.0):

| Lệnh | Kết quả |
|---|---|
| `npm run build:web` | ✅ thành công (cảnh báo chunk > 500 kB) |
| `npm run typecheck:web` | ✅ exit 0 |
| `npm run typecheck:worker` | ✅ exit 0 |
| `npm run test:unit` (= `npm test`) | ✅ 1004 tests, 1004 pass, 0 fail, 0 skipped |
| `npm run test:web` | ✅ 52 files, 710 tests pass (stderr jsdom "navigation not implemented" ở test tải replay — không làm fail) |
| `npm run test:integration` | ⚠️ 13 tests: 6 pass, 0 fail, **7 skipped** — 6 test cần `.dev.vars` (không có trên máy này), 1 là placeholder manual acceptance. Các kịch bản create/join/resume/replay ticket trên Wrangler thật **chưa được chạy** |
| `npm run test:arena` | ✅ 428 tests, 428 pass, 0 skipped |
| `npm audit` | 12 vulnerabilities (2 critical, 7 high, 3 moderate); `--omit=dev`: 5 (2 high, 3 moderate) |
| Script tái hiện lỗi đồng hồ `Room` | Tái hiện được M1, M2 |

Để chạy đủ integration: tạo `.dev.vars` (gitignored) với `OTT_INTERNAL_SECRET=<chuỗi ngẫu nhiên>` như
bước "Write .dev.vars" trong `ci.yml`. Lần rà soát này không tự tạo file đó để không thay đổi cấu hình local.

**Không chạy** (lý do): `npm run test:e2e` / browser harness (cần Playwright Chromium + Worker, thời gian dài,
không bắt buộc cho kết luận); `npm run test:arena:isolation` (chạy container với bot độc hại như fork-bomb,
cấp phát RAM — không chạy trên máy cá nhân khi chưa được đồng ý); smoke test production (không truy cập
môi trường deploy). Không có lint/format script trong dự án.

Khoảng trống test đáng chú ý: không có test `Room` cho resume khi ghế tới lượt còn mất kết nối (M1) hay
B vào khi A đang mất kết nối (M2); test `draft/run` hiện **khẳng định** hành vi của H1 thay vì chặn nó.

## 14. Limitations & Technical Debt

- Thư mục `partykit/` được gọi là legacy nhưng `apps/worker/src/persistence/room-storage.ts:6` vẫn import
  `partykit/room-storage.js` (serialize/hydrate) cho production — cần chuyển sang `packages/`.
- Game-core là UMD dựa trên `globalThis` + CommonJS; Worker import qua `@ts-ignore`, không có type.
- File rất lớn: `ArenaScreen.tsx` (1573 dòng), `ott-lobby-server.ts` (1180), `contracts/validation.mjs` (1183),
  `container-executor.mjs` (1108), `ott-game-server.ts` (931) — khó review.
- ~20 file handoff/report ở thư mục gốc, nhiều trạng thái lịch sử mâu thuẫn; `CLAUDE.md` không mô tả Arena.
- Logging: Worker có `logEvent` tối giản và nhiều `catch {}` nuốt lỗi (có chú thích lý do) — khó chẩn đoán sự cố production.
- AI: iterative deepening tạo search mới mỗi độ sâu với ngân sách riêng ⇒ tổng nút có thể tới depth × maxNodes (hard: ~400k).
- Không có lint (ESLint/Prettier) trong scripts/CI.
- Chưa có evidence hibernation/eviction thực tế của Durable Object (theo `HANDOFF.md`; không kiểm tra lại được ở đây).

## 15. Recommended Next Steps

1. **Sửa H1** (chặn `draft/run` cho non-admin khi `trustedMode`), cập nhật test tương ứng; không công bố Arena qua tunnel trước khi sửa.
2. **Sửa M1/M2** trong `Room` (+ `restoreLiveConnection`) và thêm test tại `Room.handleMove`/`resumePlayer`/`addPlayer`.
3. **Thống nhất trạng thái rollout** trong `CLAUDE.md`, `README.md`, `HANDOFF.md`; đồng bộ `OTT_BROWSER_ORIGIN` trong `wrangler.jsonc`.
4. Gỡ `partykit`/`playhtml` khỏi `dependencies`, nâng `vitest`/`vite`, chạy lại `npm audit`.
5. Sửa M3 (summary không mutate Room) và L2 (throttle trả lỗi).
6. Hợp nhất hàm sanitize tên; sửa README (Node 22, cổng Vite); sửa `$schema`.
7. Chạy e2e/isolation suite trong môi trường phù hợp và thu evidence hibernation thực tế.
8. Dọn tài liệu lịch sử vào `docs/archive/`, tách các file lớn, thêm lint vào CI.
