import { forwardRef, useId, type SVGProps } from "react";

export type PixelSpriteKind =
  | "dam"
  | "la"
  | "keo"
  | "rock"
  | "paper"
  | "scissors"
  | "bot"
  | "trophy"
  | "flag"
  | "sun"
  | "moon";

export type Seat = "A" | "B";

export interface PixelSpriteProps extends Omit<SVGProps<SVGSVGElement>, "title"> {
  kind: PixelSpriteKind;
  seat?: Seat;
  size?: number | string;
  title?: string;
  decorative?: boolean;
}

const DEFAULT_TITLES: Record<string, string> = {
  dam: "Đấm",
  rock: "Đấm",
  la: "Lá",
  paper: "Lá",
  keo: "Kéo",
  scissors: "Kéo",
  bot: "Robot",
  trophy: "Cúp",
  flag: "Cờ",
  sun: "Giao diện sáng",
  moon: "Giao diện tối",
};

const SPRITE_PATTERNS: Record<string, string[]> = {
  sun: [
    ".......YY.......",
    "..Y....YY....Y..",
    "...Y........Y...",
    ".....YYYYYY.....",
    "....YYYYYYYY....",
    "...YYYYYYYYYY...",
    "...YYYYYYYYYY...",
    "YY.YYYYYYYYYY.YY",
    "YY.YYYYYYYYYY.YY",
    "...YYYYYYYYYY...",
    "....YYYYYYYY....",
    ".....YYYYYY.....",
    "...Y........Y...",
    "..Y....YY....Y..",
    ".......YY.......",
  ],
  moon: [
    "......YYYY......",
    "....YYYY........",
    "...YYYY.........",
    "..YYYY..........",
    "..YYYY..........",
    ".YYYY...........",
    ".YYYY...........",
    ".YYYY...........",
    ".YYYYY........Y.",
    "..YYYYY.....YYY.",
    "..YYYYYYYYYYYY..",
    "...YYYYYYYYYY...",
    "....YYYYYYYY....",
    "......YYYY......",
  ],
  hammer: [
    "................",
    "...##########...",
    "..#LLLLLLLLLL#..",
    "..#LWWWWWWLLL#..",
    "..#LLLLLLLLLL#..",
    "...####HH####...",
    ".......HH.......",
    ".......HH.......",
    ".......HH.......",
    ".......HH.......",
    ".......HH.......",
    "......#HH#......",
    "......#HH#......",
    ".......##.......",
  ],
  paper: [
    "....########....",
    "...#WWWWWWWW#...",
    "...#WWWWWWWW#...",
    "...#WWLLLLWW#...",
    "...#WWWWWWWW#...",
    "...#WWLLLLWW#...",
    "...#WWWWWWWW#...",
    "...#WWLLLLWW#...",
    "...#WWWWWWWW#...",
    "...#WWLLLLWW#...",
    "...#WWWWWWWW#...",
    "...#WWWWWWWW#...",
    "....########....",
  ],
  scissors: [
    "...##......##...",
    "...#W#....#W#...",
    "....#W#..#W#....",
    ".....#W##W#.....",
    "......#WW#......",
    "......#LL#......",
    ".....#L##L#.....",
    "....#L#..#L#....",
    "..##LL#..#LL##..",
    ".#LLLL#..#LLLL#.",
    ".#L##L#..#L##L#.",
    ".#LLLL#..#LLLL#.",
    "..####....####..",
  ],
  bot: [
    ".....######.....",
    ".....#LLWL#.....",
    "...##########...",
    "..#LLLLLLLLLL#..",
    "..#L##LLLL##L#..",
    "..#LWWLLLLWWL#..",
    "..#LLLLLLLLLL#..",
    "...###LLLL###...",
    "..#LL######LL#..",
    "..#LL#LLLL#LL#..",
    "...###LLLL###...",
    ".....######.....",
    "....#LL##LL#....",
    "....#######.....",
  ],
  trophy: [
    "..############..",
    "..#YYYYYYYYYY#..",
    "###YYYYYYYYYY###",
    "#Y#YYYYYYYYYY#Y#",
    "#Y#YYYYYYYYYY#Y#",
    "###YYYYYYYYYY###",
    "...#YYYYYYYY#...",
    "....#YYYYYY#....",
    ".....######.....",
    "......#YY#......",
    "......#YY#......",
    "....###YY###....",
    "...#YYYYYYYY#...",
    "...##########...",
  ],
};

function resolvePatternKey(kind: PixelSpriteKind): string {
  if (kind === "dam" || kind === "rock") return "hammer";
  if (kind === "la") return "paper";
  if (kind === "keo") return "scissors";
  return kind;
}

export const PixelSprite = forwardRef<SVGSVGElement, PixelSpriteProps>(function PixelSprite(
  {
    kind,
    seat,
    size = 24,
    title,
    decorative = false,
    "aria-label": ariaLabel,
    width: propWidth,
    height: propHeight,
    className = "",
    style,
    ...props
  },
  ref,
) {
  const titleId = useId();
  const width = propWidth ?? size;
  const height = propHeight ?? size;
  const accessibleTitle = title ?? DEFAULT_TITLES[kind] ?? kind;

  // Resolve palette preserving Seat A Red and Seat B Blue
  const seatAColor = "var(--ui-seat-a, #c83232)";
  const seatBColor = "var(--ui-seat-b, #2364aa)";
  const neutralAccent = kind === "bot" ? "var(--ui-text-muted, #57634e)" : "currentColor";

  const accentColor = seat === "A" ? seatAColor : seat === "B" ? seatBColor : neutralAccent;
  const flagClothColor = seat === "A" ? seatAColor : seat === "B" ? seatBColor : "var(--ui-amber, #ffd33d)";
  const strokeColor = "var(--pixel-stroke, #19201b)";
  const highlightColor = "var(--pixel-highlight, #fffdf8)";
  const woodColor = "var(--pixel-wood, #8d5b32)";
  const goldColor = "var(--pixel-gold, #ffd33d)";

  const palette: Record<string, string> = {
    "#": strokeColor,
    L: accentColor,
    W: highlightColor,
    H: woodColor,
    Y: goldColor,
  };

  const patternKey = resolvePatternKey(kind);

  if (kind === "flag") {
    return (
      <svg
        {...props}
        ref={ref}
        viewBox="0 0 16 16"
        width={width}
        height={height}
        role={decorative ? undefined : "img"}
        aria-hidden={decorative ? "true" : undefined}
        aria-label={decorative ? undefined : ariaLabel}
        aria-labelledby={decorative || ariaLabel ? undefined : titleId}
        shapeRendering="crispEdges"
        className={className}
        style={{ imageRendering: "pixelated", flexShrink: 0, ...style }}
        focusable="false"
      >
        {!decorative ? <title id={titleId}>{accessibleTitle}</title> : null}
        <path d="M4 0h1v12H4zM3 12h3v1H3z" fill={strokeColor} />
        <rect x="4" y="1" width="9" height="6" fill={strokeColor} />
        <rect x="5" y="2" width="7" height="4" fill={flagClothColor} />
      </svg>
    );
  }

  const rows = SPRITE_PATTERNS[patternKey] || SPRITE_PATTERNS.bot;

  return (
    <svg
      {...props}
      ref={ref}
      viewBox="0 0 16 16"
      width={width}
      height={height}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : ariaLabel}
      aria-labelledby={decorative || ariaLabel ? undefined : titleId}
      shapeRendering="crispEdges"
      className={className}
      style={{ imageRendering: "pixelated", flexShrink: 0, ...style }}
      focusable="false"
    >
      {!decorative ? <title id={titleId}>{accessibleTitle}</title> : null}
      {rows.flatMap((row, y) =>
        [...row].map((char, x) => {
          if (char === "." || !palette[char]) return null;
          return (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={palette[char]}
            />
          );
        }),
      )}
    </svg>
  );
});
