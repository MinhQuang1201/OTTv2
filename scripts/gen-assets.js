const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 128;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(pixels) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function blank() {
  return Buffer.alloc(SIZE * SIZE * 4);
}

function blend(px, i, r, g, b, a) {
  const ia = a / 255;
  const oa = px[i + 3] / 255;
  const outA = ia + oa * (1 - ia);
  if (outA <= 0) return;
  px[i] = Math.round((r * ia + px[i] * oa * (1 - ia)) / outA);
  px[i + 1] = Math.round((g * ia + px[i + 1] * oa * (1 - ia)) / outA);
  px[i + 2] = Math.round((b * ia + px[i + 2] * oa * (1 - ia)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function stamp(px, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  blend(px, (y * SIZE + x) * 4, r, g, b, a);
}

function fillCircle(px, cx, cy, rad, r, g, b) {
  const r0 = Math.floor(cx - rad - 1);
  const r1 = Math.ceil(cx + rad + 1);
  const y0 = Math.floor(cy - rad - 1);
  const y1 = Math.ceil(cy + rad + 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = r0; x <= r1; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad;
      if (d >= 1) continue;
      const a = d <= 0 ? 255 : Math.round((1 - d) * 255);
      stamp(px, x, y, r, g, b, a);
    }
  }
}

function fillPoly(px, pts, r, g, b) {
  let minX = SIZE;
  let minY = SIZE;
  let maxX = 0;
  let maxY = 0;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  for (let y = Math.floor(minY) - 1; y <= Math.ceil(maxY) + 1; y += 1) {
    for (let x = Math.floor(minX) - 1; x <= Math.ceil(maxX) + 1; x += 1) {
      let inside = false;
      let dist = 99;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
        const xi = pts[i][0];
        const yi = pts[i][1];
        const xj = pts[j][0];
        const yj = pts[j][1];
        const dx = xj - xi;
        const dy = yj - yi;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2));
        dist = Math.min(dist, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)));
        const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-6) + xi;
        if (hit) inside = !inside;
      }
      if (inside || dist < 1.1) {
        const a = inside && dist > 1 ? 255 : Math.round(Math.max(0, 1.1 - dist) * 230);
        stamp(px, x, y, r, g, b, a);
      }
    }
  }
}

const CREAM = [243, 237, 224];
const INK = [32, 48, 46];

function drawDam() {
  const px = blank();
  fillCircle(px, 64, 72, 38, INK[0], INK[1], INK[2]);
  fillCircle(px, 64, 72, 34, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 46, 58, 14, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 64, 52, 14, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 82, 58, 14, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 54, 48, 11, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 74, 48, 11, CREAM[0], CREAM[1], CREAM[2]);
  return px;
}

function drawLa() {
  const px = blank();
  fillPoly(
    px,
    [
      [64, 18],
      [96, 58],
      [64, 112],
      [32, 58]
    ],
    CREAM[0],
    CREAM[1],
    CREAM[2]
  );
  fillPoly(
    px,
    [
      [64, 30],
      [70, 64],
      [64, 100],
      [58, 64]
    ],
    INK[0],
    INK[1],
    INK[2]
  );
  return px;
}

function drawKeo() {
  const px = blank();
  fillPoly(px, [[36, 28], [92, 78], [84, 88], [28, 38]], CREAM[0], CREAM[1], CREAM[2]);
  fillPoly(px, [[92, 28], [36, 78], [44, 88], [100, 38]], CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 64, 70, 10, INK[0], INK[1], INK[2]);
  fillCircle(px, 64, 70, 6, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 34, 96, 12, CREAM[0], CREAM[1], CREAM[2]);
  fillCircle(px, 94, 96, 12, CREAM[0], CREAM[1], CREAM[2]);
  return px;
}

const dir = path.join(__dirname, "..", "assets");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "dam.png"), encodePng(drawDam()));
fs.writeFileSync(path.join(dir, "la.png"), encodePng(drawLa()));
fs.writeFileSync(path.join(dir, "keo.png"), encodePng(drawKeo()));
console.log("Wrote assets/dam.png la.png keo.png");
