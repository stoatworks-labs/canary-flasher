// Bundle an ESP-IDF build of CANary into public/firmware/ and the manifest.
//
//   node scripts/import-firmware.ts --build <idf build dir> --release <id> \
//        --variant <id> --name "<label>" --summary "<one line>" \
//        [--commit <full sha>] [--date YYYY-MM-DD] [--recommended]
//
// It reads the build's own flasher_args.json for what goes where, so an offset
// is never typed by hand here. Every file is identified by its bytes and checked
// with the same checkPlan() the page runs before it writes, so a bundle the page
// would refuse cannot be committed in the first place.
//
// Node runs this TypeScript directly (type stripping); no build step.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkPlan, identify, OFFSETS } from "../src/image.ts";
import { validateManifest, type Manifest, type Release, type Variant } from "../src/manifest.ts";

const { values: a } = parseArgs({
  options: {
    build: { type: "string" },
    release: { type: "string" },
    variant: { type: "string" },
    name: { type: "string" },
    summary: { type: "string" },
    commit: { type: "string" },
    date: { type: "string" },
    recommended: { type: "boolean", default: false },
  },
});
for (const k of ["build", "release", "variant", "name", "summary"] as const) {
  if (!a[k]) throw new Error(`--${k} is required`);
}

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const fwRoot = join(root, "public", "firmware");
const manifestPath = join(fwRoot, "manifest.json");
const build = resolve(a.build!);

const args = JSON.parse(readFileSync(join(build, "flasher_args.json"), "utf8"));
if (args.extra_esptool_args?.chip !== "esp32s3") {
  throw new Error(`build is for ${args.extra_esptool_args?.chip}, not esp32s3`);
}
if (args.flash_settings?.flash_size !== "8MB") {
  throw new Error(`build expects ${args.flash_settings?.flash_size} of flash; the WROOM-1-N8 has 8MB`);
}

const outDir = join(fwRoot, a.release!, a.variant!);
mkdirSync(outDir, { recursive: true });

const partName: Record<string, string> = {
  bootloader: "bootloader", "partition-table": "partition table", otadata: "otadata", app: "app",
};

const parts: Variant["parts"] = [];
const writes = [];
for (const [off, rel] of Object.entries(args.flash_files as Record<string, string>)) {
  const offset = Number(off);
  const src = join(build, rel);
  const data = new Uint8Array(readFileSync(src));
  const info = identify(data);
  if (info.kind === "unknown") throw new Error(`${rel}: ${info.reason}`);
  const file = basename(rel);
  copyFileSync(src, join(outDir, file));
  parts.push({
    name: partName[info.kind],
    offset,
    path: `${a.release}/${a.variant}/${file}`,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
  writes.push({ name: file, offset, data });
}
parts.sort((x, y) => x.offset - y.offset);

const problems = checkPlan(writes, { flashBytes: 8 * 1024 * 1024 });
if (problems.length) throw new Error("the page would refuse this bundle:\n  " + problems.join("\n  "));

const appWrite = writes.find((w) => w.offset === OFFSETS.app)!;
const appInfo = identify(appWrite.data);
if (appInfo.kind !== "app") throw new Error("no app image at 0x20000");

const manifest: Manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { releases: [] };

let release: Release | undefined = manifest.releases.find((r) => r.id === a.release);
if (!release) {
  release = {
    id: a.release!,
    date: a.date ?? new Date().toISOString().slice(0, 10),
    commit: a.commit ?? "",
    variants: [],
  };
  manifest.releases.unshift(release);
}
if (a.commit) release.commit = a.commit;
if (a.date) release.date = a.date;

const variant: Variant = {
  id: a.variant!,
  name: a.name!,
  summary: a.summary!,
  recommended: a.recommended || undefined,
  app: appInfo.app,
  parts,
};
const i = release.variants.findIndex((v) => v.id === variant.id);
if (i >= 0) release.variants[i] = variant; else release.variants.push(variant);

const errors = validateManifest(manifest);
if (errors.length) throw new Error("manifest invalid:\n  " + errors.join("\n  "));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${a.release}/${a.variant}: ${parts.map((p) => `${p.name}@0x${p.offset.toString(16)}`).join(" ")} (app ${appInfo.app.version})`);
