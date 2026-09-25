# DESIGN.md

OTTv2 — night zinc print shop. Bàn cờ là vật gia công, sảnh là bàn chờ, không phải landing.

## Direction

- Macrostructure: Workbench — sảnh hai cột (tên trò / điều khiển), bàn bốn hàng (thanh, HUD B, lưới, HUD A).
- Tone: technical.
- Anchor hue: 35 (amber).
- Paper: oklch(22% 0.028 192). Accent: oklch(64% 0.18 35).
- Display: Be Vietnam Pro. Mono: Azeret Mono.
- Motif: crop mark bốn góc khung bàn.

## Color

| Token | Role |
|---|---|
| `--color-paper` | Nền đêm |
| `--color-paper-2` | HUD, thẻ sảnh |
| `--color-accent` | CTA, ô đang chọn |
| `--color-a-deep` | Quân / góc Người A |
| `--color-b-deep` | Quân / góc Người B |
| `--color-legal` | Ô đi được |
| `--color-goal-a` / `--color-goal-b` | Ô thắng |

Ghế không dùng trắng/đen cờ vua. Magenta A, cyan B.

## Type

- Display / UI: `--font-display`.
- Mã phòng, tọa độ, bộ đếm: `--font-mono`.
- Tiêu đề `font-style: normal`. Không italic heading.

## Space

Thang 4pt: `--space-3xs` 2px → `--space-3xl` 64px.

## Motion

Token `--duration-*` / `--ease-smooth-out` trong `tokens.css`.

- Toast: `.t-toast.is-open`
- Lỗi: `.t-toast.is-error` shake
- Thắng: `dialog.t-modal` + `.t-success-check`
- Ăn / đòn thua / xếp chồng: `.cell.is-burst`
- `prefers-reduced-motion: reduce` tắt animation

## Layout

- Sảnh: grid 2 cột, gãy 1 cột dưới 768px.
- Bàn: HUD B trên, lưới 9×9, HUD A dưới.
- Ô là `<button>`; rank 9→1 từ trên xuống, file a→i trái sang phải.
- Nút CTA pill, icon ↗ nằm trong vòng tròn `.btn-icon`.

## Do not

- Tím neon AI, lưới 3 card tính năng, Inter.
- Khung trình duyệt giả.
- Số liệu bịa.
- Luật chơi viết trong CSS.
