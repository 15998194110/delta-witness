import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "channels/base-app/public");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const payload = Buffer.concat([name, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload), 8 + data.length);
  return out;
}

function png(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 3);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
  };
  const fill = (x, y, w, h, color) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) set(xx, yy, color);
    }
  };
  const line = (x1, y1, x2, y2, thickness, color) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(x1 + ((x2 - x1) * i) / Math.max(1, steps));
      const y = Math.round(y1 + ((y2 - y1) * i) / Math.max(1, steps));
      fill(x - Math.floor(thickness / 2), y - Math.floor(thickness / 2), thickness, thickness, color);
    }
  };
  paint({ fill, line, width, height });
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (width * 3 + 1)] = 0;
    pixels.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const NAVY = [8, 17, 31];
const COBALT = [10, 67, 245];
const CYAN = [75, 210, 224];
const WHITE = [255, 255, 255];
const LIGHT = [247, 249, 253];
const LINE = [201, 211, 225];

function mark(fill, x, y, size, color = WHITE) {
  const u = Math.max(1, Math.floor(size / 10));
  fill(x, y, u * 2, size, color);
  fill(x + u * 3, y, u * 2, size, color);
  fill(x + u * 6, y, u * 2, size, color);
  fill(x + u * 1, y + size - u * 2, u * 2, u * 2, color);
  fill(x + u * 4, y + Math.floor(size * 0.45), u * 2, u * 2, color);
  fill(x + u * 7, y + size - u * 2, u * 2, u * 2, color);
}

function icon() {
  return png(1024, 1024, ({ fill }) => {
    fill(0, 0, 1024, 1024, NAVY);
    fill(96, 96, 832, 832, COBALT);
    fill(176, 176, 672, 672, CYAN);
    mark(fill, 282, 282, 460, NAVY);
  });
}

function splash() {
  return png(200, 200, ({ fill }) => {
    fill(0, 0, 200, 200, NAVY);
    fill(18, 18, 164, 164, CYAN);
    mark(fill, 56, 56, 88, NAVY);
  });
}

function hero() {
  return png(1200, 630, ({ fill, line }) => {
    fill(0, 0, 1200, 630, NAVY);
    fill(72, 98, 392, 392, COBALT);
    fill(112, 138, 312, 312, CYAN);
    mark(fill, 184, 188, 190, NAVY);
    fill(570, 132, 470, 28, WHITE);
    fill(570, 190, 370, 18, [177, 193, 216]);
    fill(570, 252, 510, 18, [177, 193, 216]);
    fill(570, 340, 250, 52, COBALT);
    line(570, 452, 1036, 452, 3, [88, 111, 142]);
    fill(570, 500, 330, 14, [177, 193, 216]);
  });
}

function screenshot() {
  return png(1284, 2778, ({ fill, line }) => {
    fill(0, 0, 1284, 2778, LIGHT);
    fill(0, 0, 1284, 140, WHITE);
    fill(64, 48, 44, 44, COBALT);
    fill(128, 58, 270, 22, NAVY);
    fill(1010, 60, 120, 20, [83, 101, 126]);
    fill(78, 248, 1128, 150, WHITE);
    fill(78, 452, 1128, 870, WHITE);
    fill(126, 530, 430, 48, NAVY);
    fill(126, 620, 980, 86, [232, 237, 245]);
    fill(126, 748, 980, 86, [232, 237, 245]);
    fill(126, 930, 440, 24, [83, 101, 126]);
    fill(126, 990, 920, 18, LINE);
    fill(126, 1080, 920, 18, LINE);
    fill(126, 1180, 440, 66, COBALT);
    fill(78, 1400, 1128, 760, NAVY);
    fill(126, 1500, 760, 52, WHITE);
    fill(126, 1588, 540, 20, [177, 193, 216]);
    fill(126, 1680, 890, 18, [177, 193, 216]);
    fill(126, 1740, 700, 18, [177, 193, 216]);
    fill(126, 1920, 330, 52, CYAN);
    fill(78, 2230, 1128, 340, WHITE);
    line(126, 2320, 1110, 2320, 3, LINE);
    fill(126, 2400, 520, 20, NAVY);
    fill(126, 2460, 760, 16, [83, 101, 126]);
  });
}

mkdirSync(dirname(resolve(root, "icon.png")), { recursive: true });
for (const [name, data] of [["icon.png", icon()], ["splash.png", splash()], ["hero.png", hero()], ["screenshot.png", screenshot()]]) writeFileSync(resolve(root, name), data);
console.log("Generated Base/Farcaster assets in", root);
