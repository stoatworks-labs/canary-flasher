// Everything here is pure: bytes in, facts out. No Web Serial, no DOM — so the
// checks that stop a wrong file reaching a unit are the ones the tests can reach.

/** ESP-IDF image magic, byte 0 of every bootloader and app image. */
export const IMAGE_MAGIC = 0xe9;
/** `esp_app_desc_t.magic_word`, first word of an app's first segment. */
export const APP_DESC_MAGIC = 0xabcd5432;
/** `esp_chip_id_t` for the ESP32-S3, as the image's extended header carries it. */
export const CHIP_ID_ESP32S3 = 9;
/** Magic of each 32-byte entry in an ESP-IDF partition table. */
export const PARTITION_MAGIC = 0x50aa;

/** The offsets an ESP32-S3 ESP-IDF build flashes to. The bootloader sits at 0x0
 *  on the S3 (the classic ESP32 puts it at 0x1000). */
export const OFFSETS = {
  bootloader: 0x0,
  partitionTable: 0x8000,
  otadata: 0xf000,
  app: 0x20000,
} as const;

export const CHIP_NAMES: Record<number, string> = {
  0: "ESP32", 2: "ESP32-S2", 5: "ESP32-C3", 9: "ESP32-S3", 12: "ESP32-C2",
  13: "ESP32-C6", 16: "ESP32-H2", 18: "ESP32-P4", 23: "ESP32-C5",
};

export interface AppDescription {
  version: string;
  project: string;
  time: string;
  date: string;
  idfVersion: string;
}

export type ImageInfo =
  | { kind: "app"; chipId: number; app: AppDescription }
  | { kind: "bootloader"; chipId: number }
  | { kind: "partition-table"; partitions: Partition[] }
  | { kind: "otadata" }
  | { kind: "unknown"; reason: string };

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

function cstr(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

function u32(b: Uint8Array, o: number): number {
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

/** Work out what a file is from its bytes, never its name. */
export function identify(b: Uint8Array): ImageInfo {
  if (b.length === 0) return { kind: "unknown", reason: "the file is empty" };
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
  return { kind: "unknown", reason: "not an ESP-IDF image, partition table or otadata file" };
}

/** Where a file of this kind goes. An app goes to the first app partition. */
export function defaultOffset(info: ImageInfo): number | null {
  switch (info.kind) {
    case "bootloader": return OFFSETS.bootloader;
    case "partition-table": return OFFSETS.partitionTable;
    case "otadata": return OFFSETS.otadata;
    case "app": return OFFSETS.app;
    default: return null;
  }
}

export interface PlannedWrite {
  name: string;
  offset: number;
  data: Uint8Array;
}

/**
 * The ESP-IDF project names a CANary app carries: "canary" since the rename
 * (2026-09-27), "dbcanary" before it -- a unit's own older build is still ours.
 */
export const APP_PROJECTS = ["canary", "dbcanary"];

/**
 * Everything that must be true before a set of writes goes near a unit. Returns
 * the reasons it must not, empty when it may. `allowForeign` lets an app that is
 * not a CANary build through — a deliberate override, never a default.
 */
export function checkPlan(
  writes: PlannedWrite[],
  opts: { flashBytes: number; allowForeign?: boolean },
): string[] {
  const problems: string[] = [];
  if (writes.length === 0) problems.push("nothing to write");
  const sorted = [...writes].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (w.offset % 0x1000 !== 0) {
      problems.push(`${w.name}: offset 0x${w.offset.toString(16)} is not on a 4 KB sector boundary`);
    }
    if (w.offset + w.data.length > opts.flashBytes) {
      problems.push(`${w.name}: runs past the end of flash`);
    }
    const next = sorted[i + 1];
    if (next && w.offset + w.data.length > next.offset) {
      problems.push(`${w.name} overlaps ${next.name}`);
    }
    const info = identify(w.data);
    if (info.kind === "app" || info.kind === "bootloader") {
      if (info.chipId !== CHIP_ID_ESP32S3) {
        const chip = CHIP_NAMES[info.chipId] ?? `chip id ${info.chipId}`;
        problems.push(`${w.name}: built for ${chip}, and a CANary is an ESP32-S3`);
      }
    }
    if (info.kind === "app" && !APP_PROJECTS.includes(info.app.project) && !opts.allowForeign) {
      problems.push(`${w.name}: this is "${info.app.project}", not a CANary build`);
    }
    if (info.kind === "bootloader" && w.offset !== OFFSETS.bootloader) {
      problems.push(`${w.name}: a bootloader only boots from 0x0`);
    }
    if (info.kind === "app" && w.offset < OFFSETS.app) {
      problems.push(`${w.name}: an app image below 0x${OFFSETS.app.toString(16)} would overwrite the bootloader or partition table`);
    }
  }
  return problems;
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
 * = (seq - 1) mod 2. Blank or no valid entry means the factory choice, ota_0.
 */
export function activeOtaSlot(otadata: Uint8Array): { slot: number; seq: number | null } {
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
  return best === null ? { slot: 0, seq: null } : { slot: (best - 1) % 2, seq: best };
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
