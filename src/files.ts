// From what a person hands the page to a plan: a release zip becomes a package,
// anything else is placed by what it is. Pure apart from hashing.

import { DEFAULT_TABLE_OFFSET, chipByImageId } from "./chips.ts";
import { bootPartition, identify, otadataPartition, parseOffset, type ImageInfo, type Partition } from "./image.ts";
import { readPackage, type DeviceDef, type Package, type Variant } from "./package.ts";
import type { PlannedWrite } from "./plan.ts";
import { isZip, readZip } from "./zip.ts";

export async function sha256hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A package whose parts are already in hand (a zip somebody opened). */
export interface OpenedPackage {
  pkg: Package;
  files: Map<string, Uint8Array>;
}

/**
 * A release zip, checked the way the bundle is: the manifest validates, and every
 * part is there with the size and SHA-256 it names. A first-schema CANary zip
 * (canary v0.2.0) is read as CANary's.
 */
export async function openPackageZip(bytes: Uint8Array, known: DeviceDef[]): Promise<OpenedPackage> {
  const entries = await readZip(bytes);
  const m = entries.find((e) => e.name === "manifest.json");
  if (!m) throw new Error("this zip has no manifest.json, so it is not a firmware package");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder().decode(m.data)); } catch { throw new Error("its manifest.json is not JSON"); }
  const { pkg, errors } = readPackage(json, known);
  if (!pkg || errors.length) throw new Error(`its manifest is not one this page reads: ${errors[0]}`);
  const files = new Map(entries.map((e) => [e.name, e.data]));
  for (const r of pkg.releases) for (const v of r.variants) for (const p of v.parts) {
    const data = files.get(p.path);
    if (!data) throw new Error(`${p.path} is named in the manifest and missing from the zip`);
    if (data.length !== p.size) throw new Error(`${p.path} is ${data.length} bytes, the manifest says ${p.size}`);
    if ((await sha256hex(data)) !== p.sha256) throw new Error(`${p.path} does not match its checksum`);
  }
  return { pkg, files };
}

export function variantWrites(v: Variant, file: (path: string) => Uint8Array): PlannedWrite[] {
  return v.parts.map((p) => ({ name: p.name, offset: p.offset, data: file(p.path) }));
}

/** One file of "your own build", with where it goes. */
export interface LooseFile {
  name: string;
  data: Uint8Array;
  info: ImageInfo;
  /** Where its kind belongs, or null when the page cannot tell. */
  placed: number | null;
  /** What the person typed instead, if anything. */
  typed: string;
}

/**
 * Where each loose file goes. A bootloader goes to its chip's offset, a table to
 * 0x8000, a whole-flash image to 0x0; an app and otadata go where the partition
 * table says, the one among the files if there is one, else the unit's.
 */
export function placeFiles(files: { name: string; data: Uint8Array }[], unitTable: Partition[] | null, tableOffset = DEFAULT_TABLE_OFFSET): LooseFile[] {
  const infos = files.map((f) => ({ ...f, info: identify(f.data) }));
  const own = infos.find((f) => f.info.kind === "partition-table");
  const table = own && own.info.kind === "partition-table" ? own.info.partitions : unitTable;
  return infos.map((f) => {
    const i = f.info;
    let placed: number | null = null;
    if (i.kind === "merged") placed = 0;
    else if (i.kind === "bootloader") placed = chipByImageId(i.chipId)?.bootloader ?? null;
    else if (i.kind === "partition-table") placed = tableOffset;
    else if (i.kind === "app") placed = table ? bootPartition(table)?.offset ?? null : null;
    else if (i.kind === "otadata") placed = table ? otadataPartition(table)?.offset ?? null : null;
    return { ...f, placed, typed: "" };
  });
}

/** The writes for a set of loose files, or the files still waiting for an offset. */
export function looseWrites(files: LooseFile[], table: Partition[] | null): { writes: PlannedWrite[]; unplaced: string[]; badTyping: string[] } {
  const writes: PlannedWrite[] = [];
  const unplaced: string[] = [];
  const badTyping: string[] = [];
  for (const f of files) {
    if (f.typed.trim()) {
      const at = parseOffset(f.typed, table ?? undefined);
      if (at === null) { badTyping.push(f.name); continue; }
      writes.push({ name: f.name, offset: at, data: f.data, raw: f.info.kind === "unknown" });
    } else if (f.placed !== null) {
      writes.push({ name: f.name, offset: f.placed, data: f.data });
    } else {
      unplaced.push(f.name);
    }
  }
  return { writes, unplaced, badTyping };
}

export { isZip };
