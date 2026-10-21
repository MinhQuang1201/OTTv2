import type {
  CompetitionCatalogResponse,
  FormatDescriptor,
  MapDescriptor,
  MapInitialPiece,
  ModeDescriptor,
} from "./types";

const SIZE = 9;

function buildSymmetricPieces(
  aPiecesSetup: readonly { type: "dam" | "la" | "keo"; x: number; y: number }[]
): readonly MapInitialPiece[] {
  const pieces: MapInitialPiece[] = [];

  // Seat A pieces
  aPiecesSetup.forEach((p, idx) => {
    pieces.push({
      id: `A-${p.type}-${idx}`,
      player: "A",
      seat: "A",
      type: p.type,
      x: p.x,
      y: p.y,
    });
  });

  // Seat B pieces: 180-degree rotation around center (4, 4)
  aPiecesSetup.forEach((p, idx) => {
    pieces.push({
      id: `B-${p.type}-${idx}`,
      player: "B",
      seat: "B",
      type: p.type,
      x: SIZE - 1 - p.x,
      y: SIZE - 1 - p.y,
    });
  });

  return pieces;
}

const CLASSIC_A_SETUP = [
  { type: "la", x: 4, y: 7 },
  { type: "dam", x: 5, y: 7 },
  { type: "keo", x: 4, y: 6 },
  { type: "la", x: 5, y: 6 },
  { type: "dam", x: 6, y: 6 },
  { type: "keo", x: 5, y: 5 },
  { type: "la", x: 6, y: 5 },
  { type: "dam", x: 7, y: 5 },
  { type: "keo", x: 6, y: 4 },
  { type: "la", x: 7, y: 4 },
] as const;

const FLANKS_A_SETUP = [
  { type: "la", x: 2, y: 6 },
  { type: "dam", x: 2, y: 7 },
  { type: "keo", x: 3, y: 6 },
  { type: "la", x: 3, y: 7 },
  { type: "dam", x: 3, y: 5 },
  { type: "keo", x: 6, y: 5 },
  { type: "la", x: 6, y: 6 },
  { type: "dam", x: 7, y: 6 },
  { type: "keo", x: 7, y: 7 },
  { type: "la", x: 6, y: 4 },
] as const;

const CENTER_A_SETUP = [
  { type: "dam", x: 4, y: 7 },
  { type: "la", x: 3, y: 6 },
  { type: "keo", x: 4, y: 6 },
  { type: "la", x: 5, y: 6 },
  { type: "dam", x: 3, y: 5 },
  { type: "keo", x: 4, y: 5 },
  { type: "dam", x: 5, y: 5 },
  { type: "la", x: 3, y: 4 },
  { type: "keo", x: 4, y: 4 },
  { type: "la", x: 5, y: 4 },
] as const;

export const MOCK_MAPS: readonly MapDescriptor[] = [
  {
    id: "classic",
    revision: 1,
    name: "Cổ điển (Classic)",
    description: "Bố cục chuẩn OTTv2 9x9 với 10 quân mỗi bên, xuất phát nghiêng góc truyền thống.",
    initialState: {
      turn: "A",
      pieces: buildSymmetricPieces(CLASSIC_A_SETUP),
    },
  },
  {
    id: "flanks",
    revision: 1,
    name: "Hai cánh (Flanks)",
    description: "Quân cờ dàn trải dọc hai cánh, mở rộng hành lang trung tâm tạo đột biến chiến thuật.",
    initialState: {
      turn: "A",
      pieces: buildSymmetricPieces(FLANKS_A_SETUP),
    },
  },
  {
    id: "center",
    revision: 1,
    name: "Trung tâm (Center)",
    description: "Quân cờ tập trung dày đặc ở cột trung tâm d-e-f, tạo áp lực tranh chấp trực diện.",
    initialState: {
      turn: "A",
      pieces: buildSymmetricPieces(CENTER_A_SETUP),
    },
  },
];

export const MOCK_FORMATS: readonly FormatDescriptor[] = [
  {
    id: "double-round-robin",
    name: "Vòng tròn 2 lượt (Double Round Robin)",
    description: "Mỗi cặp bot thi đấu 2 ván đổi màu quân (Ghế A và Ghế B), đảm bảo công bằng tối đa.",
  },
  {
    id: "single-round-robin",
    name: "Vòng tròn 1 lượt (Single Round Robin)",
    description: "Mỗi cặp bot thi đấu 1 ván duy nhất theo thứ tự bốc thăm.",
  },
  {
    id: "swiss",
    name: "Hệ Thụy Sĩ (Swiss System)",
    description: "Ghép cặp theo điểm số tương đồng qua từng vòng đấu, phù hợp số lượng bot lớn.",
  },
];

export const MOCK_MODES: readonly ModeDescriptor[] = [
  {
    id: "ranked",
    name: "Đấu xếp hạng (Ranked - Elo)",
  },
  {
    id: "practice",
    name: "Tập luyện / Giao hữu (Practice)",
  },
];

export function createMockCatalog(): CompetitionCatalogResponse {
  return {
    maps: MOCK_MAPS,
    formats: MOCK_FORMATS,
    modes: MOCK_MODES,
    defaults: {
      mapId: "classic",
      formatId: "double-round-robin",
      mode: "ranked",
    },
  };
}
