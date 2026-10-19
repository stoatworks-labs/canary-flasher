// Pack one bundled firmware release as a zip for a GitHub release, so a tool that
// cannot use this page (Burrow writes the firmware itself) gets the bytes it serves.
//
//   node scripts/export-release.ts [--release <id>] [--out <dir>]
//
// The release defaults to the first in public/firmware/manifest.json, the page's
// default. The zip, canary-firmware-<id>.zip, holds:
//
//   manifest.json                a Manifest with just that release: the same shape and
//                                the same <id>/<variant>/<file> paths as the bundled one
//   <id>/<variant>/<file> ...    every part, byte for byte as public/firmware has it
//
// Each entry is deflated, or stored where deflate would not shrink it. Nothing else:
// no zip64, no data descriptors, no directory entries, so the plainest extractor reads
// it. Every part is re-hashed against the manifest and the release goes through the
// same validateManifest() and checkPlan() as an import, so a bundle the page would
// refuse cannot be exported either.
//
// Node runs this TypeScript directly (type stripping); no build step.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { checkPlan } from "../src/image.ts";
import { validateManifest, type Manifest } from "../src/manifest.ts";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A zip of `entries` in order, all dated `date` (YYYY-MM-DD) so a re-export is the same file. */
export function zip(entries: ZipEntry[], date: string): Uint8Array {
  const [y, m, d] = date.split("-").map(Number);
  const dosDate = ((y - 1980) << 9) | (m << 5) | d;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const deflated = new Uint8Array(deflateRawSync(e.data, { level: 9 }));
    const method = deflated.length < e.data.length ? 8 : 0;
    const body = method === 8 ? deflated : e.data;
    const crc = crc32(e.data) >>> 0;
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error("too big for a zip without zip64");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, method === 8 ? 20 : 10, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true); // time 00:00:00
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra
    locals.push(new Uint8Array(local.buffer), name, body);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0, so the mode below is read
    central.setUint16(6, method === 8 ? 20 : 10, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, method, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, e.data.length, true);
    central.setUint16(28, name.length, true);
    // extra, comment, disk, internal attributes: all 0
    central.setUint32(38, 0o100644 << 16, true); // external attributes: a plain 0644 file
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

/** The zip for release `id` (default: the first) of the bundle at `fwRoot`. */
export function exportRelease(fwRoot: string, id?: string): { name: string; manifest: Manifest; data: Uint8Array } {
  const bundled: Manifest = JSON.parse(readFileSync(join(fwRoot, "manifest.json"), "utf8"));
  const release = id ? bundled.releases.find((r) => r.id === id) : bundled.releases[0];
  if (!release) throw new Error(`no release ${id} in ${join(fwRoot, "manifest.json")}`);

  const manifest: Manifest = { releases: [release] };
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error("manifest invalid:\n  " + errors.join("\n  "));

  const entries: ZipEntry[] = [
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") },
  ];
  for (const v of release.variants) {
    const writes = [];
    for (const p of v.parts) {
      const data = new Uint8Array(readFileSync(join(fwRoot, p.path)));
      if (data.length !== p.size) throw new Error(`${p.path}: ${data.length} bytes, manifest says ${p.size}`);
      const sha = createHash("sha256").update(data).digest("hex");
      if (sha !== p.sha256) throw new Error(`${p.path}: sha256 ${sha}, manifest says ${p.sha256}`);
      entries.push({ name: p.path, data });
      writes.push({ name: p.name, offset: p.offset, data });
    }
    const problems = checkPlan(writes, { flashBytes: 8 * 1024 * 1024 });
    if (problems.length) throw new Error(`${release.id}/${v.id}: the page would refuse this:\n  ` + problems.join("\n  "));
  }
  return { name: `canary-firmware-${release.id}.zip`, manifest, data: zip(entries, release.date) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({
    options: {
      release: { type: "string" },
      out: { type: "string", default: "." },
    },
  });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { name, data } = exportRelease(join(root, "public", "firmware"), a.release);
  mkdirSync(a.out!, { recursive: true });
  const path = join(resolve(a.out!), name);
  writeFileSync(path, data);
  console.log(`${path}: ${data.length} bytes, sha256 ${createHash("sha256").update(data).digest("hex")}`);
}
