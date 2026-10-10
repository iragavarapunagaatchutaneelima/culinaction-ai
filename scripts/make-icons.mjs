// Generates the PWA PNG icons (no image libraries needed). Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const BG = [0xc2, 0x7a, 0x12]; // turmeric
const BOWL = [0x16, 0x35, 0x2a]; // curry-leaf green
const STEAM = [0xff, 0xf7, 0xe6];

function icon(size, maskable) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const s = size / 32; // design grid 32x32
  const inset = maskable ? 0 : 0; // full-bleed background works for both
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / s;
      const gy = (y + 0.5) / s;
      let col = BG;
      let a = 255;
      // rounded corners for non-maskable
      if (!maskable) {
        const r = 7;
        const cx = gx < r ? r : gx > 32 - r ? 32 - r : gx;
        const cy = gy < r ? r : gy > 32 - r ? 32 - r : gy;
        if ((gx - cx) ** 2 + (gy - cy) ** 2 > r * r) a = 0;
      }
      // scale content toward centre for maskable safe zone
      const k = maskable ? 1.25 : 1;
      const ux = (gx - 16) * k + 16;
      const uy = (gy - 16) * k + 16 - inset;
      // bowl: lower half-disc centred (16,17.5) radius 9
      if (uy >= 17.5 && (ux - 16) ** 2 + (uy - 17.5) ** 2 <= 81) col = BOWL;
      if (uy >= 16.6 && uy < 17.5 && ux > 7 && ux < 25) col = BOWL; // rim
      // steam: three short vertical strokes
      for (const [sx, top, bot] of [
        [12, 10, 14.5],
        [16, 7.5, 14.5],
        [20, 10, 14.5],
      ]) {
        if (Math.abs(ux - sx) < 0.8 && uy > top && uy < bot) col = STEAM;
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync('web/public/icons/icon-192.png', icon(192, false));
writeFileSync('web/public/icons/icon-512.png', icon(512, false));
writeFileSync('web/public/icons/icon-maskable-512.png', icon(512, true));
console.log('Icons written to web/public/icons');
