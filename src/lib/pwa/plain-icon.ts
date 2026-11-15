import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  return out;
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * The plain mark: a ring with a dot in it (the portal's own "chosen" mark) in `foreground` on a square of
 * `background`, as a PNG. Drawn here pixel by pixel, with nothing but Node's zlib, so it works when the letter
 * renderer can't: a short name the icon font can't draw, or a renderer that fails. `mark` is the share of the width
 * the mark may take (0.6 keeps it inside a maskable icon's safe zone). Both colors are "#rrggbb".
 */
export function plainIconPng(size: number, background: string, foreground: string, mark: number): Buffer {
  const bg = rgb(background), fg = rgb(foreground);
  const center = size / 2, outer = (size * mark * 0.7) / 2, inner = outer * 0.76, dot = outer * 0.42;
  /** How much of a pixel at distance `d` from the center a disc of radius `r` covers, smoothed over one pixel. */
  const disc = (r: number, d: number) => Math.min(1, Math.max(0, r - d + 0.5));
  const row = 1 + size * 3, raw = Buffer.alloc(size * row); // each row: a filter byte (0, none), then RGB
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const ink = Math.max(disc(outer, d) - disc(inner, d), disc(dot, d));
      const at = y * row + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[at + c] = Math.round(bg[c]! + (fg[c]! - bg[c]!) * ink);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB, no interlace
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** True when `bytes` starts as a PNG whose header says it is `size` pixels square. */
export function isSquarePng(bytes: Uint8Array, size: number): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return b.length > 24 && b.subarray(0, 8).equals(SIGNATURE) && b.toString("latin1", 12, 16) === "IHDR"
    && b.readUInt32BE(16) === size && b.readUInt32BE(20) === size;
}
