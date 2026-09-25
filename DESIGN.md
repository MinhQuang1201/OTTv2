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
- Combat: `.combat-banner` như con dấu
- `prefers-reduced-motion: reduce` tắt animation

## Layout

- Sảnh: grid 2 cột, gãy 1 cột dưới 768px. Trái poster có crop mark; phải phiếu việc đánh số 01–03.
- Bàn Duel: HUD B trên, lưới 9×9, HUD A dưới. Arena: bốn HUD quanh bàn.
- Ô là `<button>`; rank 1→9 từ trên xuống, file a–i trái sang phải.
- Nút là tấm kẽm (radius 4px), không pill. Icon ↗ trong `.btn-icon` vuông.

## Do not

- Tím neon AI, lưới 3 card tính năng, Inter.
- Khung trình duyệt giả.
- Số liệu bịa.
- Luật chơi viết trong CSS.
- Hover nâng thẻ, pill iOS, radio native Windows.
