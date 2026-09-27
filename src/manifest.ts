import type { AppDescription } from "./image.ts";

/** public/firmware/manifest.json — written by scripts/import-firmware.ts only. */
export interface Manifest {
  releases: Release[];
}

export interface Release {
  /** Also the directory under public/firmware/. */
  id: string;
  date: string;
  /** Full commit of the canary repo the images were built from. */
  commit: string;
  variants: Variant[];
}

export interface Variant {
  id: string;
  name: string;
  summary: string;
  recommended?: boolean;
  app: AppDescription;
  parts: Part[];
}

export interface Part {
  name: string;
  offset: number;
  /** Relative to public/firmware/. */
  path: string;
  size: number;
  sha256: string;
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

export function validateManifest(m: Manifest): string[] {
  const e: string[] = [];
  if (!Array.isArray(m?.releases)) return ["releases is not a list"];
  const ids = new Set<string>();
  for (const r of m.releases) {
    const at = `release ${r.id}`;
    if (!ID.test(r.id ?? "")) e.push(`${at}: id must be lower-case letters, digits, . _ -`);
    if (ids.has(r.id)) e.push(`${at}: duplicate id`);
    ids.add(r.id);
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
      // "dbcanary" is the pre-rename project name, still carried by older bundled releases
      if (!["canary", "dbcanary"].includes(v.app?.project ?? "")) e.push(`${vat}: app project is ${v.app?.project}`);
      const offsets = (v.parts ?? []).map((p) => p.offset);
      for (const need of [0x0, 0x8000, 0xf000, 0x20000]) {
        if (!offsets.includes(need)) e.push(`${vat}: nothing at 0x${need.toString(16)}`);
      }
      for (const p of v.parts ?? []) {
        if (!p.path.startsWith(`${r.id}/${v.id}/`)) e.push(`${vat}: ${p.path} is outside its own directory`);
        if (!/^[0-9a-f]{64}$/.test(p.sha256)) e.push(`${vat}: ${p.name} has no sha256`);
      }
    }
  }
  return e;
}
