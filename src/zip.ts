// Reading a release zip in the page: stored and deflated entries, sizes and CRCs
// from the central directory (so a zip with data descriptors reads too). No zip64,
// no encryption: a firmware package is a few MB of plain files, and anything
// cleverer is not one of ours. DecompressionStream is in every browser with Web
// Serial and in Node, so the page and the tests read zips the same way.

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True if the bytes start like a zip (a local file header). */
export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

export async function readZip(b: Uint8Array, limit = 64 * 1024 * 1024): Promise<ZipFile[]> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipFile[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("the zip's central directory is damaged");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue; // a directory entry
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error(`${name} needs zip64`);
    total += usize;
    if (total > limit) throw new Error("the zip unpacks to more than any firmware package");
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: local header missing`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const body = b.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await inflateRaw(body);
    else throw new Error(`${name}: compression method ${method} is not one a firmware zip uses`);
    if (data.length !== usize) throw new Error(`${name}: unpacked to ${data.length} bytes, the zip says ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC does not match; the zip is damaged`);
    out.push({ name, data });
  }
  return out;
}
