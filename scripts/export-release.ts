// Write one bundled release's downloads, for a GitHub release on the device's
// public repo: the release zip Burrow and the page both read, and a whole-flash
// .bin per variant for anyone flashing with something else.
//
//   node scripts/export-release.ts --device <id> [--release <id>] [--out <dir>]
//
// The release defaults to the device's first, the page's default. Every part is
// re-hashed against the manifest and goes through the same validatePackage() and
// checkPlan() as an import, so a bundle the page would refuse cannot be exported.
// The files are the same bytes every time, and the same bytes the site mirrors
// under /downloads/ (scripts/downloads.ts), so a published asset's GitHub digest
// can be checked against a fresh export.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMain, releaseDownloads, sha256 } from "./lib.ts";

if (isMain(import.meta.url)) {
  const { values: a } = parseArgs({
    options: {
      device: { type: "string" },
      release: { type: "string" },
      out: { type: "string", default: "." },
    },
  });
  if (!a.device) throw new Error("--device is required");
  const { release, files } = releaseDownloads(a.device, a.release);
  mkdirSync(a.out!, { recursive: true });
  console.log(`${a.device} ${release.id}${release.tag ? ` (tag ${release.tag})` : ""}`);
  for (const f of files) {
    const path = join(resolve(a.out!), f.name);
    writeFileSync(path, f.data);
    console.log(`  ${path}: ${f.data.length} bytes, sha256 ${sha256(f.data)}`);
  }
}
