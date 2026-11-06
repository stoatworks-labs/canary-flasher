// Bundle an ESP-IDF build into public/firmware/<device>/ and its manifest.
//
//   node scripts/import-firmware.ts --device <id> --build <idf build dir> \
//        --release <id> --variant <id> --name "<label>" --summary "<one line>" \
//        [--commit <full sha>] [--date YYYY-MM-DD] [--tag vX.Y.Z] [--recommended] \
//        [--after "<shown once it has rebooted>"] [--extra 0x1d0000=<file> ...]
//
// It reads the build's own flasher_args.json for what goes where, so an offset is
// never typed by hand here; --extra is for an image the build makes but does not
// register for flashing. Every file is identified by its bytes and checked with the
// same checkPlan() the page runs before it writes, so a bundle the page would
// refuse cannot be committed in the first place. The device's definition is
// copied in from devices/<id>.json each time, so that file is the one to edit.
//
// Node runs this TypeScript directly (type stripping); no build step.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeImage, identify, partitionAt, type Partition } from "../src/image.ts";
import { SCHEMA, validatePackage, type Package, type Release, type Variant } from "../src/package.ts";
import { FW, readDevice, readIndex, releaseWrites, sha256 } from "./lib.ts";

const { values: a } = parseArgs({
  options: {
    device: { type: "string" },
    build: { type: "string" },
    release: { type: "string" },
    variant: { type: "string" },
    name: { type: "string" },
    summary: { type: "string" },
    commit: { type: "string" },
    date: { type: "string" },
    tag: { type: "string" },
    after: { type: "string" },
    recommended: { type: "boolean", default: false },
    extra: { type: "string", multiple: true, default: [] },
  },
});
if (!a.device || !a.release) throw new Error("--device and --release are required");

const device = readDevice(a.device!);
const dir = join(FW, device.id);
const manifestPath = join(dir, "manifest.json");

// Without --build: change a bundled release's tag, date or commit, and copy in the
// device's definition again, without touching its images.
//   node scripts/import-firmware.ts --device <id> --release <id> [--tag vX.Y.Z] [--date …] [--commit …]
if (!a.build) {
  if (!existsSync(manifestPath)) throw new Error(`${device.id} has no bundled releases`);
  const pkg: Package = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = pkg.releases.find((r) => r.id === a.release);
  if (!release) throw new Error(`${device.id} has no release ${a.release}`);
  pkg.device = device;
  if (a.tag) release.tag = a.tag;
  if (a.date) release.date = a.date;
  if (a.commit) release.commit = a.commit;
  const errors = validatePackage(pkg);
  if (errors.length) throw new Error("manifest invalid:\n  " + errors.join("\n  "));
  for (const r of pkg.releases) releaseWrites(pkg, r, dir);
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${device.id} ${release.id}: tag ${release.tag ?? "none"}, ${release.date}, ${release.commit.slice(0, 7)}`);
  process.exit(0);
}

for (const k of ["variant", "name", "summary"] as const) {
  if (!a[k]) throw new Error(`--${k} is required with --build`);
}
const build = resolve(a.build!);

/** "esp32s3" → "ESP32-S3", as esptool-js names the chip. */
const chipName = (c: string) => (c.length > 5 ? `ESP32-${c.slice(5).toUpperCase()}` : c.toUpperCase());

const args = JSON.parse(readFileSync(join(build, "flasher_args.json"), "utf8"));
const built = chipName(args.extra_esptool_args?.chip ?? "?");
if (built !== device.chip) throw new Error(`the build is for ${built}, and ${device.name} is an ${device.chip}`);
const size = args.flash_settings?.flash_size as string | undefined;
const sizeBytes = size && /^\d+MB$/.test(size) ? parseInt(size) * 1024 * 1024 : null;
if (sizeBytes !== device.flashSize) throw new Error(`the build expects ${size} of flash, and ${device.name} has ${device.flashSize / 1024 / 1024}MB`);

const files: { offset: number; src: string }[] = Object.entries(args.flash_files as Record<string, string>)
  .map(([off, rel]) => ({ offset: Number(off), src: join(build, rel) }));
for (const x of a.extra!) {
  const m = /^(0x[0-9a-f]+)=(.+)$/i.exec(x);
  if (!m) throw new Error(`--extra ${x}: want 0x<offset>=<file>`);
  files.push({ offset: Number(m[1]), src: resolve(m[2]) });
}

const outDir = join(dir, a.release!, a.variant!);
mkdirSync(outDir, { recursive: true });

const table: Partition[] = files.map((f) => identify(new Uint8Array(readFileSync(f.src))))
  .flatMap((i) => (i.kind === "partition-table" ? i.partitions : []));
const kindName: Record<string, string> = { bootloader: "bootloader", "partition-table": "partition table", otadata: "otadata", app: "app" };

const parts: Variant["parts"] = [];
let app: Variant["app"] | null = null;
for (const f of files.sort((x, y) => x.offset - y.offset)) {
  const data = new Uint8Array(readFileSync(f.src));
  const info = identify(data);
  if (info.kind === "merged") throw new Error(`${f.src}: a whole-flash image; import the build's parts instead`);
  if (info.kind === "app") {
    if (app) throw new Error("the build flashes two apps; a variant holds one");
    app = info.app;
  }
  const file = basename(f.src);
  if (parts.some((p) => p.path.endsWith(`/${file}`))) throw new Error(`two files are called ${file}`);
  copyFileSync(f.src, join(outDir, file));
  parts.push({
    name: kindName[info.kind] ?? partitionAt(table, f.offset)?.label ?? file,
    offset: f.offset,
    path: `${a.release}/${a.variant}/${file}`,
    size: data.length,
    sha256: sha256(data),
  });
  console.log(`  ${file} @ 0x${f.offset.toString(16)}: ${describeImage(info)}`);
}
if (!app) throw new Error("the build flashes no app image");
if (!device.projects.includes(app.project)) throw new Error(`the app is "${app.project}", and ${device.id}'s projects are ${device.projects.join(", ")}`);

const pkg: Package = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { schema: SCHEMA, device, releases: [] };
pkg.schema = SCHEMA;
pkg.device = device;

let release: Release | undefined = pkg.releases.find((r) => r.id === a.release);
if (!release) {
  release = { id: a.release!, date: a.date ?? new Date().toISOString().slice(0, 10), commit: a.commit ?? "", variants: [] };
  pkg.releases.unshift(release);
}
if (a.commit) release.commit = a.commit;
if (a.date) release.date = a.date;
if (a.tag) release.tag = a.tag;

const variant: Variant = {
  id: a.variant!,
  name: a.name!,
  summary: a.summary!,
  recommended: a.recommended || undefined,
  after: a.after || undefined,
  app,
  parts,
};
const i = release.variants.findIndex((v) => v.id === variant.id);
if (i >= 0) release.variants[i] = variant; else release.variants.push(variant);

const errors = validatePackage(pkg);
if (errors.length) throw new Error("manifest invalid:\n  " + errors.join("\n  "));
releaseWrites(pkg, release, dir); // re-reads every part and runs checkPlan() on each variant
writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");

const index = readIndex();
if (!index.devices.includes(device.id)) {
  index.devices.push(device.id);
  writeFileSync(join(FW, "index.json"), JSON.stringify(index, null, 2) + "\n");
}
console.log(`${device.id} ${a.release}/${a.variant}: ${parts.length} parts, app ${app.project} ${app.version}`);
