# DESIGN.md

OTTv2 — night zinc print shop. Bàn cờ là tấm kẽm trên máy in, sảnh là phiếu việc, không phải landing.

## Direction

- Macrostructure: Workbench — sảnh hai cột (poster / phiếu việc), bàn bốn hàng (thanh, HUD B, lưới, HUD A).
- Tone: technical.
- Anchor hue: 35 (amber mực).
- Paper: oklch(17% 0.03 192). Accent: oklch(72% 0.19 35).
- Display: Be Vietnam Pro. Mono: Azeret Mono.
- Motif: dấu register (chữ thập) bốn góc poster, bàn, thẻ thắng.

## Color

| Token | Role |
|---|---|
| `--color-paper` | Nền đêm xưởng |
| `--color-paper-2` | HUD, phiếu, poster |
| `--color-accent` | Mực in, CTA, ô đang chọn |
| `--color-a-deep` | Quân / góc Người A |
| `--color-b-deep` | Quân / góc Người B |
| `--color-c-deep` | Quân / góc Người C |
| `--color-d-deep` | Quân / góc Người D |
| `--color-legal` | Ô đi được |
| `--color-goal-a` / `--color-goal-b` | Ô thắng |

Ghế không dùng trắng/đen cờ vua. Magenta A, cyan B, vàng C, lục D — giếng mực.

## Type

- Display / UI: `--font-display`.
- Mã phòng, tọa độ, đồng hồ, số bản: `--font-mono`.
- Tiêu đề `font-style: normal`. Không italic heading.

## Space

Thang 4pt: `--space-3xs` 2px → `--space-3xl` 64px.

## Motion

Token `--duration-*` / `--ease-smooth-out` trong `tokens.css`.

- Sảnh vào: `.poster` / `.lobby-core` `press-in` (một nhịp, delay 80ms).
- Toast: `.t-toast.is-open`
- Lỗi: `.t-toast.is-error` shake
- Thắng: `dialog.t-modal` + `.t-success-check`
- Ăn / đòn thua: `.cell.is-burst`
- Combat: `.combat-banner` như con dấu; `data-kind="strike_loss"` mực vàng
- Nước vừa đi: `.cell.is-from` / `.is-to` (lấy từ history, không từ CSS)
- Xem trước oẳn tù tì: `.is-win` lục / `.is-loss` vàng trên ô hợp lệ có quân địch
- Ô thắng: node `.goal-label` từ `rules.formatSquare`, không cứng tọa độ trong CSS
- Lượt: HUD `data-active`, đồng hồ `ink-pulse`, `.turn-line[data-seat]`
- Lượt mình: con dấu `.you-stamp` dưới lưới (ẩn dòng lượt), `data-yours`
- Ăn: `.ink-splat` mực, đếm HUD `.is-punch`, haptic ngắn và tone Web Audio nếu đang bật
- Âm thanh: nút `ON/OFF` trên thanh bàn, lưu trong `localStorage`; tone ngắn, không chặn thao tác
- Sảnh: vòng RPS bằng asset quân, giếng mực 2/4 ghế, CTA «Chơi ngay»
- playHTML: cursor, `data-playhtml-hover` trên phiếu/phòng, con dấu «Bản in». Không gắn lên ô bàn.
- `prefers-reduced-motion: reduce` tắt animation

## Layout

- Sảnh: grid 2 cột, gãy 1 cột dưới 768px. Safe-area `viewport-fit=cover`. Trái poster có crop mark; phải phiếu việc grouped (radius 12).
- Bàn: `100dvh`, không cuộn trang. Lưới 9×9 co theo `100cqmin` của `.board-stage` (container-type: size), ô nhìn co theo viewport.
- Compact (≤480px hoặc chiều cao thấp): HUD một hàng, ẩn hint / dock khi thiếu chiều cao, ẩn poster khi phone landscape.
- Regular (tablet / laptop): HUD + dock.
- Expanded (≥1100px): cell-cap lớn hơn.
- Chrome: thanh bàn như toolbar (blur zinc), control radius 10–12. Ô nhìn co theo viewport nhưng button hitbox luôn `44px` trên mobile; click quy đổi theo tọa độ bàn. Giữ Be Vietnam Pro.
- Ô là `<button>`; rank 1→9 từ trên xuống, file a–i trái sang phải.
- Nút là tấm kẽm bo 10px, không pill 999px. Icon ↗ trong `.btn-icon`.
- Icon quân dùng `assets/rps-atlas.png`; `renderBoard` tái sử dụng 81 button prefab, không instantiate DOM liên tục.

## Do not

- Tím neon AI, lưới 3 card tính năng, Inter, SF Pro làm mặt chính.
- Khung cửa sổ macOS giả.
- Số liệu bịa.
- Luật chơi viết trong CSS.
- Hover nâng thẻ, radio native Windows.
