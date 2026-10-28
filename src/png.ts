import { withinDeadline } from "./deadline";

const MAX_PIXELS = 16_000_000;
const MAX_INFLATED_BYTES = 64_000_000;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Checks complete chunks/CRC, required image data, legal IHDR, and the bounded
// decompressed scanline structure. This is file integrity, not source truth.
export async function isPng(bytes: Uint8Array): Promise<boolean> {
  if (bytes.length < 57 || !signature.every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let ended = false, palette = false, idatEnded = false;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const size = view.getUint32(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) !== 0) return false;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) return false;
    if (offset === 8 && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (offset !== 8 || size !== 13) return false;
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      depth = bytes[offset + 16]; color = bytes[offset + 17]; interlace = bytes[offset + 20];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width * height > MAX_PIXELS || !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) return false;
    } else if (type === "PLTE") {
      if (palette || idat.length || !size || size % 3 || size > 768 || color === 0 || color === 4 || (color === 3 && size / 3 > 2 ** depth)) return false;
      palette = true;
    } else if (type === "IDAT") {
      if (idatEnded || (color === 3 && !palette)) return false;
      idat.push(bytes.subarray(offset + 8, end - 4));
    } else if (type === "IEND") {
      if (size || !idat.some(part => part.length) || end !== bytes.length) return false;
      ended = true;
    } else if ((bytes[offset + 4] & 32) === 0) return false;
    if (idat.length && type !== "IDAT") idatEnded = true;
    offset = end;
  }
  if (!ended) return false;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows: { stride: number; count: number }[] = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (!w || !h) continue;
    const stride = 1 + Math.ceil(w * channels * depth / 8);
    expected += stride * h;
    rows.push({ stride, count: h });
  }
  if (expected > MAX_INFLATED_BYTES) return false;
  let index = 0;
  const compressed = new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < idat.length) controller.enqueue(idat[index++]); else controller.close();
  }});
  const reader = compressed.pipeThrough(new DecompressionStream("deflate")).getReader();
  try {
    return await withinDeadline((async () => {
      let total = 0, pass = 0, row = 0, column = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) return total === expected;
        total += value.byteLength;
        if (total > expected) return false;
        for (const byte of value) {
          if (column === 0 && byte > 4) return false;
          if (++column === rows[pass].stride) {
            column = 0;
            if (++row === rows[pass].count) { row = 0; pass++; }
          }
        }
      }
    })(), 5000, "png_validation_timeout", () => { void reader.cancel().catch(() => {}); });
  } catch { return false; }
  finally { void reader.cancel().catch(() => {}); }
}
