// Everything here is pure: bytes in, facts out. No Web Serial, no DOM — so the
// checks that stop a wrong file reaching a unit are the ones the tests can reach.

import { CHIPS, DEFAULT_TABLE_OFFSET, TABLE_SIZE, chipByImageId } from "./chips.ts";

/** ESP-IDF image magic, byte 0 of every bootloader and app image. */
export const IMAGE_MAGIC = 0xe9;
/** `esp_app_desc_t.magic_word`, first word of an app's first segment. */
export const APP_DESC_MAGIC = 0xabcd5432;
/** Magic of each 32-byte entry in an ESP-IDF partition table. */
export const PARTITION_MAGIC = 0x50aa;

export const PART_APP = 0x00;
export const PART_DATA = 0x01;
export const SUB_FACTORY = 0x00;
export const SUB_OTA_0 = 0x10;
export const SUB_OTADATA = 0x00;

export interface AppDescription {
  version: string;
  project: string;
  time: string;
  date: string;
  idfVersion: string;
}

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export type ImageInfo =
  | { kind: "app"; chipId: number; app: AppDescription }
  | { kind: "bootloader"; chipId: number }
  | { kind: "partition-table"; partitions: Partition[] }
  | { kind: "otadata" }
  /** A whole-flash image from 0x0 (esptool merge-bin, or a read-back): bootloader,
   *  partition table and whatever partitions follow, in one file. */
  | { kind: "merged"; chipId: number; partitions: Partition[] }
  | { kind: "unknown"; reason: string };

function cstr(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

export function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

/**
 * The app descriptor sits at the very start of the first segment: 24 bytes of
 * image header, 8 of segment header, then `esp_app_desc_t`. Returns null if the
 * magic is not there, which is what a bootloader image looks like.
 */
export function readAppDescription(b: Uint8Array): AppDescription | null {
  const d = 24 + 8;
  if (b.length < d + 256 || u32(b, d) !== APP_DESC_MAGIC) return null;
  // magic(4) secure_version(4) reserv1[2](8) version[32] project_name[32]
  // time[16] date[16] idf_ver[32] app_elf_sha256[32] ...
  return {
    version: cstr(b, d + 16, 32),
    project: cstr(b, d + 48, 32),
    time: cstr(b, d + 80, 16),
    date: cstr(b, d + 96, 16),
    idfVersion: cstr(b, d + 112, 32),
  };
}

/** Chip ID from the extended image header (bytes 12–13). */
export function imageChipId(b: Uint8Array): number {
  return u16(b, 12);
}

export function parsePartitionTable(b: Uint8Array): Partition[] | null {
  const out: Partition[] = [];
  for (let o = 0; o + 32 <= b.length; o += 32) {
    const magic = u16(b, o);
    if (magic === 0xffff) break;             // end of table (erased flash)
    if (magic === 0xebeb) break;             // MD5 entry follows the last partition
    if (magic !== PARTITION_MAGIC) return out.length ? out : null;
    out.push({
      type: b[o + 2],
      subtype: b[o + 3],
      offset: u32(b, o + 4),
      size: u32(b, o + 8),
      label: cstr(b, o + 12, 16),
    });
  }
  return out.length ? out : null;
}

/**
 * A whole-flash image: the bootloader at its chip's offset and a partition table
 * at 0x8000, in one file that starts at 0x0. Space below the bootloader (the first
 * 4 or 8 KB on the chips that boot from 0x1000 or 0x2000) is padding.
 */
function asMerged(b: Uint8Array): ImageInfo | null {
  if (b.length < DEFAULT_TABLE_OFFSET + 32 || u16(b, DEFAULT_TABLE_OFFSET) !== PARTITION_MAGIC) return null;
  for (const at of new Set(CHIPS.map((c) => c.bootloader))) {
    if (b.length < at + 24 || b[at] !== IMAGE_MAGIC) continue;
    const chipId = imageChipId(b.subarray(at));
    if (chipByImageId(chipId)?.bootloader !== at) continue;
    const partitions = parsePartitionTable(b.subarray(DEFAULT_TABLE_OFFSET, DEFAULT_TABLE_OFFSET + TABLE_SIZE));
    if (partitions) return { kind: "merged", chipId, partitions };
  }
  return null;
}

/** Work out what a file is from its bytes, never its name. */
export function identify(b: Uint8Array): ImageInfo {
  if (b.length === 0) return { kind: "unknown", reason: "the file is empty" };
  const merged = asMerged(b);
  if (merged) return merged;
  if (b[0] === IMAGE_MAGIC && b.length >= 24) {
    const chipId = imageChipId(b);
    const app = readAppDescription(b);
    return app ? { kind: "app", chipId, app } : { kind: "bootloader", chipId };
  }
  if (u16(b, 0) === PARTITION_MAGIC) {
    const partitions = parsePartitionTable(b);
    if (partitions) return { kind: "partition-table", partitions };
  }
  // ota_data_initial.bin is two erased 4 KB sectors: all 0xFF, 8 KB long.
  if (b.length === 0x2000 && b.every((x) => x === 0xff)) return { kind: "otadata" };
  return { kind: "unknown", reason: "not an ESP-IDF image, partition table, otadata or whole-flash image" };
}

/** What a file is, in a few words, for a table on screen. */
export function describeImage(info: ImageInfo): string {
  const chip = (id: number) => chipByImageId(id)?.name ?? `chip id ${id}`;
  switch (info.kind) {
    case "app": return `${info.app.project} ${info.app.version} · ${chip(info.chipId)}`;
    case "bootloader": return `bootloader · ${chip(info.chipId)}`;
    case "partition-table": return info.partitions.map((p) => p.label).join(", ");
    case "otadata": return "blank otadata";
    case "merged": return `whole flash · ${chip(info.chipId)}`;
    case "unknown": return "raw data";
  }
}

// ---------------------------------------------------------------- partitions

/** The app partition the bootloader starts when otadata is blank: factory if
 *  there is one, otherwise ota_0. */
export function bootPartition(table: Partition[]): Partition | undefined {
  const apps = table.filter((p) => p.type === PART_APP);
  return apps.find((p) => p.subtype === SUB_FACTORY) ?? apps.find((p) => p.subtype === SUB_OTA_0) ?? apps[0];
}

export function otadataPartition(table: Partition[]): Partition | undefined {
  return table.find((p) => p.type === PART_DATA && p.subtype === SUB_OTADATA);
}

export function partitionAt(table: Partition[], offset: number): Partition | undefined {
  return table.find((p) => p.offset === offset);
}

export function partitionContaining(table: Partition[], offset: number, length: number): Partition | undefined {
  return table.find((p) => offset >= p.offset && offset + length <= p.offset + p.size);
}

/** The app partition ota_N, or undefined if the table has no such slot. */
export function otaSlot(table: Partition[], n: number): Partition | undefined {
  return table.find((p) => p.type === PART_APP && p.subtype === SUB_OTA_0 + n);
}

// esp_rom_crc32_le as the bootloader calls it on otadata: seeded with
// UINT32_MAX, and the ROM routine inverts on the way in and out.
function crc32le(seed: number, b: Uint8Array): number {
  let crc = ~seed >>> 0;
  for (const x of b) {
    crc ^= x;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

/**
 * Which OTA slot the bootloader will pick, from the 8 KB otadata partition:
 * two sectors each holding an `esp_ota_select_entry_t` (seq u32, label[20],
 * state u32, crc u32). The valid entry with the higher sequence wins, and slot
 * = (seq - 1) mod (number of OTA slots). Blank or no valid entry means the
 * factory choice: `seq` is null and the caller picks `bootPartition()`.
 */
export function activeOtaSlot(otadata: Uint8Array, slots = 2): { slot: number; seq: number | null } {
  let best: number | null = null;
  for (const base of [0, 0x1000]) {
    if (otadata.length < base + 32) continue;
    const seq = u32(otadata, base);
    if (seq === 0xffffffff || seq === 0) continue;
    const crc = u32(otadata, base + 28);
    if (crc32le(0xffffffff, otadata.subarray(base, base + 4)) !== crc) continue;
    const state = u32(otadata, base + 24);
    // ESP_OTA_IMG_INVALID (3) and ABORTED (4) are skipped by the bootloader.
    if (state === 3 || state === 4) continue;
    if (best === null || seq > best) best = seq;
  }
  return best === null ? { slot: 0, seq: null } : { slot: (best - 1) % Math.max(slots, 1), seq: best };
}

/** Test hook: build a valid otadata entry, as esp_ota_set_boot_partition would. */
export function otadataEntry(seq: number, state = 2): Uint8Array {
  const e = new Uint8Array(32).fill(0xff);
  const dv = new DataView(e.buffer);
  dv.setUint32(0, seq, true);
  e.fill(0, 4, 24);
  dv.setUint32(24, state, true);
  dv.setUint32(28, crc32le(0xffffffff, e.subarray(0, 4)), true);
  return e;
}

export function hex(n: number): string {
  return "0x" + n.toString(16).padStart(5, "0");
}

/**
 * An offset as a person types it: "0x20000", "128K", "1M", or a partition label.
 * Bare digits are refused: esptool reads "20000" as decimal and most people mean
 * hex, and a write is the wrong place to guess which.
 */
export function parseOffset(text: string, table?: Partition[]): number | null {
  const t = text.trim();
  if (!t) return null;
  const byLabel = table?.find((p) => p.label === t);
  if (byLabel) return byLabel.offset;
  let m = /^0x([0-9a-f]+)$/i.exec(t);
  if (m) return parseInt(m[1], 16);
  m = /^(\d+)\s*([KM])$/i.exec(t);
  if (m) return Number(m[1]) * (m[2].toUpperCase() === "K" ? 1024 : 1024 * 1024);
  return null;
}
