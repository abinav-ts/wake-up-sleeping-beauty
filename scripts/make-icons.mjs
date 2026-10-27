// Generates monochrome Lorenz-butterfly PNG icons without any dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Lorenz butterfly points, normalised to roughly [-0.5, 0.5]
function lorenz() {
  const f = ([x, y, z]) => [10 * (y - x), x * (28 - z) - y, x * y - (8 / 3) * z];
  const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
  const dt = 0.002;
  let p = [0.1, 0, 0];
  const pts = [];
  for (let i = 0; i < 40000; i++) {
    const k1 = f(p), k2 = f(add(p, k1, dt / 2)), k3 = f(add(p, k2, dt / 2)), k4 = f(add(p, k3, dt));
    p = p.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    if (i > 2500) pts.push([p[0] / 52, (p[2] - 25) / 52]);
  }
  return pts;
}
const PTS = lorenz();

function png(size) {
  const cov = new Float32Array(size * size);
  const rad = Math.max(0.9, size * 0.0028);
  for (const [u, v] of PTS) {
    const cx = (0.5 + u) * size, cy = (0.5 - v) * size + size * 0.02;
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.min(1, Math.max(0, rad + 0.5 - d));
      if (a > cov[y * size + x]) cov[y * size + x] = a;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = Math.round(255 * Math.min(1, cov[y * size + x] * 0.95));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = c; // white butterfly on black
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
console.log('icons written');
