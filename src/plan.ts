// checkPlan() is the one gate every write goes through: the page runs it before
// enabling Flash and again inside Session.write() against the connected unit, the
// scripts run it before a release can be bundled or exported, and the tests run it
// over every bundled variant. Pure, like image.ts.

import { DEFAULT_TABLE_OFFSET, TABLE_SIZE, chipLabel, type Chip } from "./chips.ts";
import {
  PART_APP, PART_DATA, bootPartition, hex, identify, otadataPartition, partitionAt, type ImageInfo, type Partition,
} from "./image.ts";

export interface PlannedWrite {
  name: string;
  offset: number;
  data: Uint8Array;
  /** The person typed this offset for data the page cannot identify. Raw writes
   *  skip the "is this firmware" checks, never the flash-geometry ones. */
  raw?: boolean;
}

export interface PlanContext {
  /** The chip being written: the connected unit's, or the device's before one is connected. */
  chip: Chip;
  flashBytes: number;
  /** ESP-IDF project names an app must carry. Unset means any project: your own file. */
  projects?: readonly string[];
  /** The partition table read off the unit on connect, used when the plan brings none. */
  unitTable?: Partition[] | null;
  /** Where the bootloader reads the table. 0x8000 unless the device says otherwise. */
  tableOffset?: number;
}

/** One thing the plan puts on flash: a write, or a piece of a whole-flash image. */
export interface Component {
  name: string;
  offset: number;
  data: Uint8Array;
  info: ImageInfo;
  raw: boolean;
}

function blank(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0xff) return false;
  return true;
}

/**
 * The plan as the bootloader will see it: every write, with a whole-flash image
 * broken into its bootloader, partition table and non-blank partitions.
 */
export function components(writes: PlannedWrite[], tableOffset = DEFAULT_TABLE_OFFSET): Component[] {
  const out: Component[] = [];
  for (const w of writes) {
    const info = identify(w.data);
    if (info.kind !== "merged") {
      out.push({ name: w.name, offset: w.offset, data: w.data, info, raw: !!w.raw && info.kind === "unknown" });
      continue;
    }
    const piece = (name: string, from: number, to: number) => {
      const data = w.data.subarray(from, Math.min(to, w.data.length));
      if (data.length && !blank(data)) out.push({ name: `${w.name} → ${name}`, offset: w.offset + from, data, info: identify(data), raw: false });
    };
    const boot = bootloaderStart(w.data);
    piece("bootloader", boot, tableOffset);
    piece("partition table", tableOffset, tableOffset + TABLE_SIZE);
    for (const p of info.partitions) if (p.offset < w.data.length) piece(p.label, p.offset, p.offset + p.size);
  }
  return out;
}

function bootloaderStart(b: Uint8Array): number {
  for (const at of [0x0, 0x1000, 0x2000]) if (b[at] === 0xe9) return at;
  return 0;
}

/** The partition table the plan leaves on the unit: its own if it writes one, else the unit's. */
export function effectiveTable(parts: Component[], ctx: Pick<PlanContext, "unitTable">): Partition[] | null {
  const own = parts.find((c) => c.info.kind === "partition-table");
  if (own && own.info.kind === "partition-table") return own.info.partitions;
  return ctx.unitTable ?? null;
}

/**
 * Everything that must be true before a set of writes goes near a unit. Returns
 * the reasons it must not, empty when it may.
 */
export function checkPlan(writes: PlannedWrite[], ctx: PlanContext): string[] {
  const problems: string[] = [];
  const tableOffset = ctx.tableOffset ?? DEFAULT_TABLE_OFFSET;
  if (writes.length === 0) return ["nothing to write"];

  // Geometry, on the writes as given.
  const sorted = [...writes].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (!Number.isInteger(w.offset) || w.offset < 0) { problems.push(`${w.name}: has no offset`); continue; }
    if (w.offset % 0x1000 !== 0) problems.push(`${w.name}: offset ${hex(w.offset)} is not on a 4 KB sector boundary`);
    if (w.data.length === 0) problems.push(`${w.name}: is empty`);
    if (w.offset + w.data.length > ctx.flashBytes) problems.push(`${w.name}: runs past the end of the ${mb(ctx.flashBytes)} flash`);
    const next = sorted[i + 1];
    if (next && w.offset + w.data.length > next.offset) problems.push(`${w.name} overlaps ${next.name}`);
  }
  if (problems.length) return problems;

  const parts = components(writes, tableOffset);
  const table = effectiveTable(parts, ctx);
  const chipOk = (c: Component, chipId: number) => {
    if (chipId === ctx.chip.imageId) return true;
    problems.push(`${c.name}: built for ${chipLabel(chipId)}, and this is an ${ctx.chip.name}`);
    return false;
  };

  for (const w of writes) {
    if (identify(w.data).kind === "merged" && w.offset !== 0) problems.push(`${w.name}: a whole-flash image only goes at 0x0`);
  }

  for (const c of parts) {
    const { info } = c;
    switch (info.kind) {
      case "merged":
        break; // a merged image nested in a merged image is just data
      case "bootloader":
        chipOk(c, info.chipId);
        if (c.offset !== ctx.chip.bootloader) {
          problems.push(`${c.name}: an ${ctx.chip.name} only boots a bootloader from ${hex(ctx.chip.bootloader)}`);
        }
        break;
      case "partition-table":
        if (c.offset !== tableOffset) problems.push(`${c.name}: the bootloader reads the partition table at ${hex(tableOffset)}`);
        problems.push(...checkTable(info.partitions, ctx.flashBytes, tableOffset).map((p) => `${c.name}: ${p}`));
        break;
      case "app": {
        chipOk(c, info.chipId);
        if (ctx.projects && !ctx.projects.includes(info.app.project)) {
          problems.push(`${c.name}: this is "${info.app.project}", not a build for this device`);
        }
        if (!table) { problems.push(`${c.name}: there is no partition table to say where an app goes, so include one`); break; }
        const p = partitionAt(table, c.offset);
        if (!p || p.type !== PART_APP) problems.push(`${c.name}: ${hex(c.offset)} is not the start of an app partition`);
        else if (c.data.length > p.size) problems.push(`${c.name}: is bigger than the ${p.label} partition`);
        break;
      }
      case "otadata": {
        if (!table) { problems.push(`${c.name}: there is no partition table to say where otadata goes`); break; }
        const p = otadataPartition(table);
        if (!p) problems.push(`${c.name}: the partition table has no otadata partition`);
        else if (c.offset !== p.offset) problems.push(`${c.name}: otadata goes at ${hex(p.offset)}`);
        else if (c.data.length > p.size) problems.push(`${c.name}: is bigger than the otadata partition`);
        break;
      }
      case "unknown": {
        if (c.raw) break;
        // A data image (a filesystem, an image for a co-processor) is fine where it
        // starts a data partition and fits in it. Anything else needs an offset
        // somebody chose on purpose.
        const p = table ? partitionAt(table, c.offset) : undefined;
        if (p && p.type === PART_DATA && c.data.length <= p.size) break;
        if (p && p.type === PART_DATA) { problems.push(`${c.name}: is bigger than the ${p.label} partition`); break; }
        problems.push(`${c.name}: ${info.reason}. Give it an offset to write it as raw data`);
        break;
      }
    }
  }
  return problems;
}

/** What is wrong with a partition table as the bootloader would read it. */
export function checkTable(table: Partition[], flashBytes: number, tableOffset = DEFAULT_TABLE_OFFSET): string[] {
  const problems: string[] = [];
  const sorted = [...table].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.offset < tableOffset + 0x1000) problems.push(`${p.label} starts below the end of the partition table`);
    if (p.offset + p.size > flashBytes) problems.push(`${p.label} runs past the end of the ${mb(flashBytes)} flash`);
    if (p.type === PART_APP && p.offset % 0x10000 !== 0) problems.push(`${p.label} is an app partition not on a 64 KB boundary`);
    const next = sorted[i + 1];
    if (next && p.offset + p.size > next.offset) problems.push(`${p.label} overlaps ${next.label}`);
  }
  if (!bootPartition(table)) problems.push("there is no app partition");
  return problems;
}

/**
 * Things worth saying that are not reasons to refuse: which partition will boot,
 * and what a new partition table leaves behind.
 */
export function planNotes(writes: PlannedWrite[], ctx: PlanContext): string[] {
  const notes: string[] = [];
  const parts = components(writes, ctx.tableOffset);
  const table = effectiveTable(parts, ctx);
  if (!table) return notes;
  const boot = bootPartition(table);
  const apps = parts.filter((c) => c.info.kind === "app");
  const writesOtadata = parts.some((c) => c.info.kind === "otadata");
  for (const a of apps) {
    const p = partitionAt(table, a.offset);
    if (p && boot && p !== boot && !writesOtadata && otadataPartition(table)) {
      notes.push(`${a.name} goes to ${p.label}, and nothing here tells the bootloader to start it.`);
    }
  }
  const newTable = parts.find((c) => c.info.kind === "partition-table");
  if (newTable && ctx.unitTable && !sameTable(table, ctx.unitTable)) {
    notes.push("This changes the unit's partition table. Anything in a partition that moved is lost.");
    if (boot && !apps.some((a) => a.offset === boot.offset)) notes.push(`Nothing is written to ${boot.label}, which is what the new table boots.`);
  }
  return notes;
}

function sameTable(a: Partition[], b: Partition[]): boolean {
  const key = (t: Partition[]) => t.map((p) => `${p.label}/${p.type}/${p.subtype}/${p.offset}/${p.size}`).sort().join(";");
  return key(a) === key(b);
}

/**
 * A lone app image boots only if otadata points at the slot it went into. When
 * the plan writes an app to the partition a blank otadata boots and says nothing
 * about otadata itself, add a blank one. Without it, a unit that last updated over
 * the air keeps booting its other slot and the flash looks like it did nothing.
 */
export function withOtadataReset(writes: PlannedWrite[], ctx: Pick<PlanContext, "unitTable" | "tableOffset">): { writes: PlannedWrite[]; added: boolean } {
  const parts = components(writes, ctx.tableOffset);
  const table = effectiveTable(parts, ctx);
  if (!table) return { writes, added: false };
  const boot = bootPartition(table);
  const ota = otadataPartition(table);
  if (!boot || !ota) return { writes, added: false };
  const hasBootApp = parts.some((c) => c.info.kind === "app" && c.offset === boot.offset);
  const touchesOtadata = writes.some((w) => w.offset < ota.offset + ota.size && w.offset + w.data.length > ota.offset);
  if (!hasBootApp || touchesOtadata) return { writes, added: false };
  return {
    writes: [...writes, { name: `otadata (blank: boot ${boot.label})`, offset: ota.offset, data: new Uint8Array(ota.size).fill(0xff) }],
    added: true,
  };
}

/**
 * Lay parts end to end as one whole-flash image from 0x0, gaps filled with 0xFF
 * (erased flash), as esptool merge-bin does. Written at 0x0 it is the same flash
 * as the parts written one by one.
 */
export function mergeParts(writes: PlannedWrite[]): Uint8Array {
  const end = Math.max(...writes.map((w) => w.offset + w.data.length));
  const out = new Uint8Array(end).fill(0xff);
  for (const w of writes) out.set(w.data, w.offset);
  return out;
}

function mb(n: number): string {
  return n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : `${n / 1024} KB`;
}
