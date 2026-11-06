// A firmware package: what one device's firmware is, and where its parts go.
// docs/PACKAGE.md is the specification, and Burrow reads the same files, so a
// change here is a change to a format two programs share.
//
//   public/firmware/index.json                  the devices the page offers, in order
//   public/firmware/<device>/manifest.json      a Package: the device and every bundled release
//   public/firmware/<device>/<release>/<variant>/<file>
//
// A release zip (`<device>-firmware-<release>.zip`, on GitHub and mirrored under
// /downloads/) is the same thing cut down to one release: its manifest.json is a
// Package with one entry in `releases`, and its paths are unchanged.

import { CHIPS, DEFAULT_TABLE_OFFSET, chipByName, type Chip } from "./chips.ts";
import type { AppDescription } from "./image.ts";

export const SCHEMA = 2;

export interface DeviceDef {
  /** Lower case; the directory under public/firmware/ and the start of every download name. */
  id: string;
  name: string;
  /** esptool's CHIP_NAME, e.g. "ESP32-S3". */
  chip: string;
  /** Bytes of flash every unit has. A unit with less is refused. */
  flashSize: number;
  /** ESP-IDF project names this device's apps carry, newest first. */
  projects: string[];
  /** owner/name of the public GitHub repo whose releases carry the zips. */
  repo?: string;
  /** The device's page on stoatworks-labs.com. */
  page?: string;
  /** Said once, plainly, wherever the device is offered: how proven the firmware is. */
  status?: string;
  /** How the unit appears, for the port chooser filter and the help text. */
  usb?: { vendorId: number; productId?: number; label?: string }[];
  /** Steps to get the unit talking. */
  connect?: string[];
  /** Paragraphs for "it will not connect", before the download-mode steps. */
  notes?: string[];
  /** Steps to force the ROM's download mode when the firmware will not let go of the port. */
  bootMode?: string[];
  /** What an ordinary flash (no full erase) leaves on the unit. */
  keeps?: string;
  /** CONFIG_PARTITION_TABLE_OFFSET, when it is not 0x8000. */
  tableOffset?: number;
}

export interface Package {
  schema: number;
  device: DeviceDef;
  /** Newest first. The first is the page's default. */
  releases: Release[];
}

export interface Release {
  /** The firmware build: also the directory its parts sit under. */
  id: string;
  /** The GitHub release on device.repo that carries this release's downloads, if it is published. */
  tag?: string;
  date: string;
  /** Full commit of the firmware source the images were built from. */
  commit: string;
  notes?: string;
  variants: Variant[];
}

export interface Variant {
  id: string;
  name: string;
  summary: string;
  recommended?: boolean;
  /** Shown once the unit has rebooted into this variant. */
  after?: string;
  app: AppDescription;
  parts: Part[];
}

export interface Part {
  name: string;
  offset: number;
  /** Relative to the manifest. */
  path: string;
  size: number;
  sha256: string;
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

export function deviceChip(d: DeviceDef): Chip {
  const c = chipByName(d.chip);
  if (!c) throw new Error(`${d.id}: unknown chip ${d.chip}`);
  return c;
}

export function validateDevice(d: DeviceDef): string[] {
  const e: string[] = [];
  const at = `device ${d?.id}`;
  if (!d || typeof d !== "object") return ["no device"];
  if (!ID.test(d.id ?? "")) e.push(`${at}: id must be lower-case letters, digits, . _ -`);
  if (!d.name) e.push(`${at}: needs a name`);
  if (!chipByName(d.chip)) e.push(`${at}: chip must be one of ${CHIPS.map((c) => c.name).join(", ")}`);
  if (!Number.isInteger(d.flashSize) || d.flashSize < 1 << 20 || (d.flashSize & (d.flashSize - 1)) !== 0) {
    e.push(`${at}: flashSize must be a power of two of at least 1 MB, in bytes`);
  }
  if (!Array.isArray(d.projects) || !d.projects.length || d.projects.some((p) => typeof p !== "string" || !p)) {
    e.push(`${at}: needs the project names its apps carry`);
  }
  if (d.repo !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(d.repo)) e.push(`${at}: repo must be owner/name`);
  if (d.tableOffset !== undefined && (d.tableOffset % 0x1000 !== 0 || d.tableOffset < 0x8000)) e.push(`${at}: bad tableOffset`);
  return e;
}

/** Everything wrong with a package that can be told without its bytes. */
export function validatePackage(m: Package): string[] {
  if (!m || typeof m !== "object") return ["not a package"];
  const e: string[] = [];
  if (m.schema !== SCHEMA) e.push(`schema is ${m.schema}, this page reads ${SCHEMA}`);
  e.push(...validateDevice(m.device));
  if (!Array.isArray(m.releases) || !m.releases.length) return [...e, "releases is not a list, or is empty"];
  if (e.length) return e;
  const chip = deviceChip(m.device);
  const tableOffset = m.device.tableOffset ?? DEFAULT_TABLE_OFFSET;
  const ids = new Set<string>();
  for (const r of m.releases) {
    const at = `release ${r.id}`;
    if (!ID.test(r.id ?? "")) e.push(`${at}: id must be lower-case letters, digits, . _ -`);
    if (ids.has(r.id)) e.push(`${at}: duplicate id`);
    ids.add(r.id);
    if (r.tag !== undefined && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(r.tag)) e.push(`${at}: tag must look like v1.2.3`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) e.push(`${at}: date must be YYYY-MM-DD`);
    if (!/^[0-9a-f]{40}$/.test(r.commit ?? "")) e.push(`${at}: commit must be a full 40-character sha`);
    if (!r.variants?.length) e.push(`${at}: no variants`);
    const vids = new Set<string>();
    for (const v of r.variants ?? []) {
      const vat = `${at}/${v.id}`;
      if (!ID.test(v.id ?? "")) e.push(`${vat}: bad id`);
      if (vids.has(v.id)) e.push(`${vat}: duplicate variant`);
      vids.add(v.id);
      if (!v.name || !v.summary) e.push(`${vat}: needs a name and a summary`);
      if (!m.device.projects.includes(v.app?.project ?? "")) e.push(`${vat}: app project is ${v.app?.project}, not one of ${m.device.id}'s`);
      const offsets = (v.parts ?? []).map((p) => p.offset);
      if (!offsets.includes(chip.bootloader)) e.push(`${vat}: no bootloader at 0x${chip.bootloader.toString(16)}`);
      if (!offsets.includes(tableOffset)) e.push(`${vat}: no partition table at 0x${tableOffset.toString(16)}`);
      if (offsets.length < 3) e.push(`${vat}: needs a bootloader, a partition table and an app at least`);
      for (const p of v.parts ?? []) {
        if (!p.name) e.push(`${vat}: a part has no name`);
        if (!Number.isInteger(p.offset) || p.offset % 0x1000 !== 0) e.push(`${vat}: ${p.name} is not on a 4 KB sector boundary`);
        if (typeof p.path !== "string" || !p.path.startsWith(`${r.id}/${v.id}/`) || p.path.includes("..")) {
          e.push(`${vat}: ${p.path} is outside its own directory`);
        }
        if (!Number.isInteger(p.size) || p.size <= 0) e.push(`${vat}: ${p.name} has no size`);
        if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? "")) e.push(`${vat}: ${p.name} has no sha256`);
      }
    }
  }
  return e;
}

/** The first schema: a bare `{ releases }`, CANary's only (canary v0.2.0). */
export interface LegacyManifest {
  schema?: undefined;
  releases: Release[];
}

/**
 * A package from a manifest of either schema. A legacy one names no device, so it
 * takes the first known device whose project names cover every variant's app.
 */
export function readPackage(json: unknown, known: DeviceDef[]): { pkg: Package; errors: string[] } | { pkg: null; errors: string[] } {
  const m = json as Package | LegacyManifest;
  if (m && typeof m === "object" && m.schema === undefined && Array.isArray((m as LegacyManifest).releases)) {
    const projects = new Set(m.releases.flatMap((r) => (r.variants ?? []).map((v) => v.app?.project)));
    const device = known.find((d) => [...projects].every((p) => d.projects.includes(p ?? "")));
    if (!device) return { pkg: null, errors: [`a first-schema manifest for ${[...projects].join(", ")}, which is no device this page knows`] };
    const pkg: Package = { schema: SCHEMA, device, releases: m.releases };
    return { pkg, errors: validatePackage(pkg) };
  }
  const pkg = m as Package;
  const errors = validatePackage(pkg);
  return errors.length && !pkg?.device ? { pkg: null, errors } : { pkg, errors };
}

export function zipName(d: DeviceDef, r: Release): string {
  return `${d.id}-firmware-${r.id}.zip`;
}

export function mergedName(d: DeviceDef, r: Release, v: Variant): string {
  return `${d.id}-firmware-${r.id}-${v.id}.bin`;
}

/** A release asset's direct link: pinned to its tag, never latest/download. */
export function githubAsset(d: DeviceDef, r: Release, name: string): string | null {
  return d.repo && r.tag ? `https://github.com/${d.repo}/releases/download/${r.tag}/${name}` : null;
}

/** public/firmware/index.json */
export interface BundleIndex {
  schema: number;
  devices: string[];
}
