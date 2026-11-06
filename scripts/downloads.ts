// Build public/downloads/: every bundled release's zip and whole-flash images,
// so the page can link to them on its own origin as well as on GitHub. Run before
// `vite` and `vite build` (predev, prebuild). Generated, never committed: the
// bundle under public/firmware/ is the one copy of the bytes in git.
//
//   public/downloads/<device>/<device>-firmware-<release>.zip
//   public/downloads/<device>/<device>-firmware-<release>-<variant>.bin
//   public/downloads/index.json    { <device>: { <release>: [{ name, size, sha256 }] } }

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isMain, readBundle, readIndex, releaseDownloads, sha256 } from "./lib.ts";

export type DownloadsIndex = Record<string, Record<string, { name: string; size: number; sha256: string }[]>>;

export function writeDownloads(out = join(ROOT, "public", "downloads")): number {
  rmSync(out, { recursive: true, force: true });
  const index: DownloadsIndex = {};
  let n = 0;
  for (const id of readIndex().devices) {
    mkdirSync(join(out, id), { recursive: true });
    index[id] = {};
    for (const r of readBundle(id).releases) {
      index[id][r.id] = [];
      for (const f of releaseDownloads(id, r.id).files) {
        writeFileSync(join(out, id, f.name), f.data);
        index[id][r.id].push({ name: f.name, size: f.data.length, sha256: sha256(f.data) });
        n++;
      }
    }
  }
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return n;
}

if (isMain(import.meta.url)) console.log(`public/downloads: ${writeDownloads()} files`);
