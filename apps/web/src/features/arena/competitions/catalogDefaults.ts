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

// 1. Classic Map: 10 pieces/seat (4 Lá, 3 Đấm, 3 Kéo) matching standard game-core configuration
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

// 2. Flanks Map: Pieces distributed along outer wings
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

// 3. Center Map: Pieces tightly grouped in central columns
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

export const DEFAULT_MAPS: readonly MapDescriptor[] = [
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
    name: "Trung lộ (Center)",
    description: "Toàn bộ lực lượng tập trung dày đặc tại khu vực trung tâm, giao tranh khốc liệt ngay từ đầu.",
    initialState: {
      turn: "A",
      pieces: buildSymmetricPieces(CENTER_A_SETUP),
    },
  },
];

export const DEFAULT_FORMATS: readonly FormatDescriptor[] = [
  {
    id: "double-round-robin",
    name: "Vòng tròn 2 lượt (Double Round-Robin)",
    description: "Mỗi cặp bot thi đấu 2 trận đổi ghế lượt đi và lượt về. Thể thức công bằng và toàn diện nhất.",
  },
  {
    id: "single-round-robin",
    name: "Vòng tròn 1 lượt (Single Round-Robin)",
    description: "Mỗi cặp bot thi đấu chính xác 1 trận với ghế được bốc thăm ngẫu nhiên.",
  },
  {
    id: "swiss",
    name: "Hệ Thụy Sĩ (Swiss System)",
    description: "Ghép cặp theo điểm số tương đồng qua từng vòng, hạn chế tái đấu. Thích hợp số lượng bot lớn.",
  },
];

export const DEFAULT_MODES: readonly ModeDescriptor[] = [
  {
    id: "ranked",
    name: "Xếp hạng Elo (Ranked)",
  },
  {
    id: "practice",
    name: "Tập luyện / Giao hữu (Practice)",
  },
];

export function createDefaultCatalog(): CompetitionCatalogResponse {
  return {
    maps: DEFAULT_MAPS,
    formats: DEFAULT_FORMATS,
    modes: DEFAULT_MODES,
    defaults: {
      mapId: "classic",
      formatId: "double-round-robin",
      mode: "ranked",
    },
  };
}
