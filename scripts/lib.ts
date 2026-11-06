// What the scripts share: reading the bundle off disk, checking a release the way
// the page would, and building the downloads. Node only.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";
import { mergedName, validateDevice, validatePackage, zipName, deviceChip, type BundleIndex, type DeviceDef, type Package, type Release } from "../src/package.ts";
import { checkPlan, mergeParts, type PlannedWrite } from "../src/plan.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FW = join(ROOT, "public", "firmware");
export const DEVICES = join(ROOT, "devices");

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function readDevice(id: string, dir = DEVICES): DeviceDef {
  const d: DeviceDef = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  const e = validateDevice(d);
  if (e.length) throw new Error(`devices/${id}.json:\n  ` + e.join("\n  "));
  if (d.id !== id) throw new Error(`devices/${id}.json says its id is ${d.id}`);
  return d;
}

export function allDevices(dir = DEVICES): DeviceDef[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readDevice(f.slice(0, -5), dir));
}

export function readIndex(fw = FW): BundleIndex {
  return JSON.parse(readFileSync(join(fw, "index.json"), "utf8"));
}

export function readBundle(id: string, fw = FW): Package {
  return JSON.parse(readFileSync(join(fw, id, "manifest.json"), "utf8"));
}

/** The writes of every variant of a release, each part re-read and re-hashed against the manifest. */
export function releaseWrites(pkg: Package, release: Release, dir: string): Map<string, PlannedWrite[]> {
  const out = new Map<string, PlannedWrite[]>();
  for (const v of release.variants) {
    const writes: PlannedWrite[] = [];
    for (const p of v.parts) {
      const data = new Uint8Array(readFileSync(join(dir, p.path)));
      if (data.length !== p.size) throw new Error(`${p.path}: ${data.length} bytes, manifest says ${p.size}`);
      if (sha256(data) !== p.sha256) throw new Error(`${p.path}: sha256 ${sha256(data)}, manifest says ${p.sha256}`);
      writes.push({ name: p.name, offset: p.offset, data });
    }
    const problems = checkPlan(writes, {
      chip: deviceChip(pkg.device),
      flashBytes: pkg.device.flashSize,
      projects: pkg.device.projects,
      tableOffset: pkg.device.tableOffset,
    });
    if (problems.length) throw new Error(`${pkg.device.id} ${release.id}/${v.id}: the page would refuse this:\n  ` + problems.join("\n  "));
    out.set(v.id, writes);
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * A zip of `entries` in order, all dated `date` (YYYY-MM-DD) so a re-export is the
 * same file. Each entry is deflated, or stored where deflate would not shrink it.
 * Nothing else: no zip64, no data descriptors, no directory entries, so the
 * plainest extractor reads it.
 */
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

export interface Download {
  name: string;
  data: Uint8Array;
}

/**
 * The downloads of one bundled release: the zip (its own manifest.json, a Package
 * with just this release, and the parts byte for byte) and one whole-flash image
 * per variant, to write at 0x0 with any tool.
 */
export function releaseDownloads(deviceId: string, releaseId?: string, fw = FW): { release: Release; files: Download[] } {
  const bundled = readBundle(deviceId, fw);
  const release = releaseId ? bundled.releases.find((r) => r.id === releaseId) : bundled.releases[0];
  if (!release) throw new Error(`no release ${releaseId} in ${join(fw, deviceId, "manifest.json")}`);
  const pkg: Package = { schema: bundled.schema, device: bundled.device, releases: [release] };
  const errors = validatePackage(pkg);
  if (errors.length) throw new Error("manifest invalid:\n  " + errors.join("\n  "));
  const writes = releaseWrites(pkg, release, join(fw, deviceId));

  const entries: ZipEntry[] = [{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(pkg, null, 2) + "\n") }];
  for (const v of release.variants) for (const p of v.parts) entries.push({ name: p.path, data: readFileSync(join(fw, deviceId, p.path)) });
  const files: Download[] = [{ name: zipName(pkg.device, release), data: zip(entries, release.date) }];
  for (const v of release.variants) files.push({ name: mergedName(pkg.device, release, v), data: mergeParts(writes.get(v.id)!) });
  return { release, files };
}

export function isMain(url: string): boolean {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
}
