import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chipByName, type Chip } from "../src/chips.ts";
import { looseWrites, openPackageZip, placeFiles } from "../src/files.ts";
import {
  activeOtaSlot, identify, otadataEntry, parseOffset, parsePartitionTable, type Partition,
} from "../src/image.ts";
import { md5hex } from "../src/md5.ts";
import { deviceChip, readPackage, validatePackage, type Package } from "../src/package.ts";
import { checkPlan, checkTable, components, mergeParts, planNotes, withOtadataReset, type PlanContext, type PlannedWrite } from "../src/plan.ts";
import { readZip } from "../src/zip.ts";
import { FW, allDevices, readBundle, readDevice, readIndex, releaseDownloads, zip } from "../scripts/lib.ts";

const MB8 = 8 * 1024 * 1024;
const S3 = chipByName("ESP32-S3")!;
const ESP32 = chipByName("ESP32")!;
const C3 = chipByName("ESP32-C3")!;
const canary = readBundle("canary");
const bytes = (dev: string, p: string): Uint8Array => new Uint8Array(readFileSync(join(FW, dev, p)));

function bundle(pkg: Package = canary, r = 0, v = 0): PlannedWrite[] {
  return pkg.releases[r].variants[v].parts.map((p) => ({ name: p.name, offset: p.offset, data: bytes(pkg.device.id, p.path) }));
}
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ chip: S3, flashBytes: MB8, projects: canary.device.projects, ...over });
const fresh = (): PlannedWrite[] => bundle().map((w) => ({ ...w, data: w.data.slice() }));
const at = (ws: PlannedWrite[], offset: number) => ws.find((w) => w.offset === offset)!;
const canaryTable = (identify(at(bundle(), 0x8000).data) as { partitions: Partition[] }).partitions;

/** A partition table's bytes, as gen_esp32part.py writes them (no MD5 entry). */
function tableBytes(parts: Partition[]): Uint8Array {
  const b = new Uint8Array(0xc00).fill(0xff);
  const dv = new DataView(b.buffer);
  parts.forEach((p, i) => {
    const o = i * 32;
    dv.setUint16(o, 0x50aa, true);
    b[o + 2] = p.type;
    b[o + 3] = p.subtype;
    dv.setUint32(o + 4, p.offset, true);
    dv.setUint32(o + 8, p.size, true);
    b.fill(0, o + 12, o + 28);
    b.set(new TextEncoder().encode(p.label), o + 12);
    dv.setUint32(o + 28, 0, true);
  });
  return b;
}

/** An image header for `chipId`; with a project, an app with its descriptor. */
function image(chipId: number, project?: string, size = 0x1000): Uint8Array {
  const b = new Uint8Array(size);
  b[0] = 0xe9;
  b[12] = chipId;
  if (project) {
    new DataView(b.buffer).setUint32(32, 0xabcd5432, true);
    b.set(new TextEncoder().encode("v1.0.0"), 32 + 16);
    b.set(new TextEncoder().encode(project), 32 + 48);
  }
  return b;
}

// A Cuckoo-shaped layout: factory app at 0x10000, no otadata, two raw data partitions.
const factoryTable: Partition[] = [
  { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
  { label: "phy_init", type: 1, subtype: 1, offset: 0xf000, size: 0x1000 },
  { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x1c0000 },
  { label: "rp_ram", type: 1, subtype: 0x40, offset: 0x1d0000, size: 0x90000 },
  { label: "rp_fw", type: 1, subtype: 0x41, offset: 0x260000, size: 0x100000 },
];

describe("the bundle", () => {
  const index = readIndex();

  it("lists a manifest for every device, and a definition for each", () => {
    expect(index.schema).toBe(2);
    expect(index.devices.length).toBeGreaterThan(0);
    const defs = allDevices().map((d) => d.id);
    for (const id of index.devices) expect(defs).toContain(id);
  });

  for (const id of readIndex().devices) {
    describe(id, () => {
      const pkg = readBundle(id);

      it("validates", () => expect(validatePackage(pkg)).toEqual([]));

      it("carries devices/<id>.json unchanged", () => expect(pkg.device).toEqual(readDevice(id)));

      it("matches the files on disk, byte for byte", () => {
        for (const r of pkg.releases) for (const v of r.variants) for (const p of v.parts) {
          const data = bytes(id, p.path);
          expect(data.length, p.path).toBe(p.size);
          expect(createHash("sha256").update(data).digest("hex"), p.path).toBe(p.sha256);
        }
      });

      it("passes the same check the page runs before writing", () => {
        for (let r = 0; r < pkg.releases.length; r++) for (let v = 0; v < pkg.releases[r].variants.length; v++) {
          const c: PlanContext = { chip: deviceChip(pkg.device), flashBytes: pkg.device.flashSize, projects: pkg.device.projects };
          expect(checkPlan(bundle(pkg, r, v), c), `${pkg.releases[r].id}/${pkg.releases[r].variants[v].id}`).toEqual([]);
        }
      });

      it("records the app descriptor that is really in the image", () => {
        for (let r = 0; r < pkg.releases.length; r++) pkg.releases[r].variants.forEach((v, vi) => {
          const apps = components(bundle(pkg, r, vi)).filter((c) => c.info.kind === "app");
          expect(apps.length).toBe(1);
          const info = apps[0].info;
          if (info.kind === "app") expect(info.app).toEqual(v.app);
        });
      });
    });
  }

  it("rejects a manifest with a short commit, a missing bootloader or a foreign project", () => {
    const bad: Package = structuredClone(canary);
    bad.releases[0].commit = "4bd1ac5";
    bad.releases[0].variants[0].parts = bad.releases[0].variants[0].parts.filter((p) => p.offset !== 0);
    bad.releases[0].variants[1].app.project = "blinky";
    const errors = validatePackage(bad).join("\n");
    expect(errors).toMatch(/40-character/);
    expect(errors).toMatch(/no bootloader at 0x0/);
    expect(errors).toMatch(/app project is blinky/);
  });

  it("puts a classic ESP32's bootloader at 0x1000", () => {
    const pkg: Package = structuredClone(canary);
    pkg.device = { ...pkg.device, chip: "ESP32" };
    expect(validatePackage(pkg).join()).toMatch(/no bootloader at 0x1000/);
  });
});

describe("identify", () => {
  const [boot, table, ota, app] = bundle().sort((a, b) => a.offset - b.offset).map((w) => w.data);

  it("tells each real part apart by content", () => {
    expect(identify(boot).kind).toBe("bootloader");
    expect(identify(app).kind).toBe("app");
    expect(identify(ota).kind).toBe("otadata");
    const t = identify(table);
    expect(t.kind).toBe("partition-table");
    if (t.kind === "partition-table") {
      expect(t.partitions.map((p) => p.label)).toEqual(["nvs", "otadata", "phy_init", "ota_0", "ota_1", "coredump"]);
      expect(t.partitions.find((p) => p.label === "ota_1")!.offset).toBe(0x1f0000);
    }
  });

  it("reads the chip as ESP32-S3 from both images", () => {
    for (const b of [boot, app]) {
      const i = identify(b);
      expect(i.kind === "app" || i.kind === "bootloader" ? i.chipId : -1).toBe(9);
    }
  });

  it("knows a whole-flash image, from 0x0 or with a classic ESP32's padding", () => {
    const m = identify(mergeParts(bundle()));
    expect(m.kind).toBe("merged");
    if (m.kind === "merged") expect(m.chipId).toBe(9);
    const classic = mergeParts([
      { name: "bl", offset: 0x1000, data: image(0) },
      { name: "pt", offset: 0x8000, data: tableBytes(factoryTable) },
    ]);
    const c = identify(classic);
    expect(c.kind).toBe("merged");
    if (c.kind === "merged") expect(c.chipId).toBe(0);
  });

  it("does not mistake a classic ESP32 bootloader at 0x0 for a whole-flash image", () => {
    const wrong = mergeParts([{ name: "bl", offset: 0, data: image(0) }, { name: "pt", offset: 0x8000, data: tableBytes(factoryTable) }]);
    expect(identify(wrong).kind).not.toBe("merged");
  });

  it("calls random bytes and an empty file unknown", () => {
    const junk = randomBytes(4096);
    junk[0] = 0;
    expect(identify(junk).kind).toBe("unknown");
    expect(identify(new Uint8Array()).kind).toBe("unknown");
  });

  it("parses a table it wrote", () => {
    expect(parsePartitionTable(tableBytes(factoryTable))).toEqual(factoryTable);
  });
});

describe("checkPlan refuses", () => {
  it("an app built for another chip", () => {
    const p = fresh();
    at(p, 0x20000).data[12] = 0; // chip id -> ESP32
    expect(checkPlan(p, ctx()).join()).toMatch(/built for ESP32, and this is an ESP32-S3/);
  });

  it("the right firmware on the wrong chip", () => {
    expect(checkPlan(bundle(), ctx({ chip: C3 })).join()).toMatch(/built for ESP32-S3, and this is an ESP32-C3/);
  });

  it("an app from another project for a device, and lets it through as your own file", () => {
    const p = fresh();
    at(p, 0x20000).data.set(new TextEncoder().encode("blinky\0\0"), 32 + 48);
    expect(checkPlan(p, ctx()).join()).toMatch(/"blinky", not a build for this device/);
    expect(checkPlan(p, ctx({ projects: undefined }))).toEqual([]);
  });

  it("an app built before the rename, as dbcanary, is still a CANary's", () => {
    const p = fresh();
    at(p, 0x20000).data.set(new TextEncoder().encode("dbcanary\0"), 32 + 48);
    expect(checkPlan(p, ctx())).toEqual([]);
  });

  it("overlapping writes", () => {
    const p = fresh();
    at(p, 0xf000).offset = 0x8000; // onto the table
    expect(checkPlan(p, ctx()).join()).toMatch(/overlaps|sector/);
  });

  it("an app that is not at the start of an app partition", () => {
    const p = fresh();
    at(p, 0x20000).offset = 0x400000;
    expect(checkPlan(p, ctx()).join()).toMatch(/0x400000 is not the start of an app partition/);
  });

  it("a lone app with no table on the plan or the unit", () => {
    expect(checkPlan([at(bundle(), 0x20000)], ctx()).join()).toMatch(/no partition table to say where an app goes/);
    expect(checkPlan([at(bundle(), 0x20000)], ctx({ unitTable: canaryTable }))).toEqual([]);
  });

  it("a bootloader anywhere but its chip's offset", () => {
    const p = fresh().filter((w) => w.offset !== 0);
    p.push({ name: "bl", offset: 0x300000, data: bundle()[0].data });
    expect(checkPlan(p, ctx()).join()).toMatch(/only boots a bootloader from 0x00000/);
    const classic = [{ name: "bl", offset: 0, data: image(0) }];
    expect(checkPlan(classic, ctx({ chip: ESP32, projects: undefined })).join()).toMatch(/ESP32 only boots a bootloader from 0x01000/);
    expect(checkPlan([{ ...classic[0], offset: 0x1000 }], ctx({ chip: ESP32, projects: undefined }))).toEqual([]);
  });

  it("a unit with too little flash", () => {
    expect(checkPlan(bundle(), ctx({ flashBytes: 256 * 1024 })).join()).toMatch(/past the end of the 256 KB flash/);
  });

  it("an unaligned offset", () => {
    const p = fresh();
    at(p, 0x20000).offset = 0x20010;
    expect(checkPlan(p, ctx()).join()).toMatch(/sector boundary/);
  });

  it("raw data nobody placed, and takes it once an offset is typed", () => {
    const junk = new Uint8Array(randomBytes(0x1000));
    junk[0] = 0;
    expect(checkPlan([{ name: "junk", offset: 0x700000, data: junk }], ctx({ unitTable: canaryTable })).join()).toMatch(/Give it an offset/);
    expect(checkPlan([{ name: "junk", offset: 0x700000, data: junk, raw: true }], ctx({ unitTable: canaryTable }))).toEqual([]);
  });

  it("a whole-flash image anywhere but 0x0", () => {
    expect(checkPlan([{ name: "all", offset: 0x10000, data: mergeParts(bundle()) }], ctx()).join()).toMatch(/only goes at 0x0/);
  });

  it("a partition table whose partitions overlap or run off the flash", () => {
    const t = structuredClone(factoryTable);
    t[4].size = 0x200000;
    expect(checkTable(t, 4 * 1024 * 1024).join()).toMatch(/rp_fw runs past the end of the 4 MB flash/);
    t[3].size = 0xa0000;
    expect(checkTable(t, 4 * 1024 * 1024).join()).toMatch(/rp_ram overlaps rp_fw/);
  });
});

describe("checkPlan takes", () => {
  it("a whole-flash image of a release, as the parts would be", () => {
    const merged = { name: "canary.bin", offset: 0, data: mergeParts(bundle()) };
    expect(checkPlan([merged], ctx())).toEqual([]);
    const parts = components([merged]).map((c) => [c.offset, c.info.kind]);
    expect(parts).toEqual([[0, "bootloader"], [0x8000, "partition-table"], [0x20000, "app"]]);
  });

  it("refuses a whole-flash image of another device's firmware for a device", () => {
    const p = fresh();
    at(p, 0x20000).data.set(new TextEncoder().encode("blinky\0\0"), 32 + 48);
    expect(checkPlan([{ name: "x.bin", offset: 0, data: mergeParts(p) }], ctx()).join()).toMatch(/"blinky"/);
  });

  it("data images where they start a data partition", () => {
    const writes = [
      { name: "app", offset: 0x10000, data: image(5, "cuckoo_ui") },
      { name: "rp_ram", offset: 0x1d0000, data: new Uint8Array(0x8000).fill(7) },
      { name: "rp_fw", offset: 0x260000, data: new Uint8Array(0x8000).fill(9) },
    ];
    const c = ctx({ chip: C3, flashBytes: 4 << 20, projects: ["cuckoo_ui"], unitTable: factoryTable });
    expect(checkPlan(writes, c)).toEqual([]);
    writes[2].data = new Uint8Array(0x101000);
    expect(checkPlan(writes, c).join()).toMatch(/bigger than the rp_fw partition|past the end/);
  });
});

describe("withOtadataReset", () => {
  const app = at(bundle(), 0x20000);

  it("adds a blank otadata beside a lone app in the slot a blank otadata boots", () => {
    const { writes, added } = withOtadataReset([app], { unitTable: canaryTable });
    expect(added).toBe(true);
    const ota = at(writes, 0xf000);
    expect(ota.data.length).toBe(0x2000);
    expect(identify(ota.data).kind).toBe("otadata");
    expect(checkPlan(writes, ctx({ unitTable: canaryTable }))).toEqual([]);
  });

  it("leaves a plan alone that already carries otadata, or a whole-flash image", () => {
    expect(withOtadataReset(bundle(), {}).added).toBe(false);
    expect(withOtadataReset([{ name: "m", offset: 0, data: mergeParts(bundle()) }], {}).added).toBe(false);
  });

  it("has nothing to do on a factory layout", () => {
    expect(withOtadataReset([{ name: "a", offset: 0x10000, data: image(5, "cuckoo_ui") }], { unitTable: factoryTable }).added).toBe(false);
  });

  it("says when an app goes to a slot nothing will boot", () => {
    const notes = planNotes([{ ...app, offset: 0x1f0000 }], ctx({ unitTable: canaryTable }));
    expect(notes.join()).toMatch(/goes to ota_1, and nothing here tells the bootloader to start it/);
  });
});

describe("loose files", () => {
  it("are placed by what they are", () => {
    const files = bundle().map((w) => ({ name: w.name, data: w.data }));
    const placed = placeFiles(files, null);
    expect(placed.map((f) => f.placed)).toEqual([0, 0x8000, 0xf000, 0x20000]);
  });

  it("a lone app goes where the unit's table boots", () => {
    expect(placeFiles([{ name: "a", data: at(bundle(), 0x20000).data }], canaryTable)[0].placed).toBe(0x20000);
    expect(placeFiles([{ name: "a", data: image(5, "cuckoo_ui") }], factoryTable)[0].placed).toBe(0x10000);
    expect(placeFiles([{ name: "a", data: at(bundle(), 0x20000).data }], null)[0].placed).toBe(null);
  });

  it("raw data waits for an offset, by number or by partition name", () => {
    const f = placeFiles([{ name: "fs.bin", data: new Uint8Array(0x1000).fill(1) }], factoryTable);
    expect(looseWrites(f, factoryTable).unplaced).toEqual(["fs.bin"]);
    f[0].typed = "rp_fw";
    expect(looseWrites(f, factoryTable).writes[0]).toMatchObject({ offset: 0x260000, raw: true });
    f[0].typed = "20000";
    expect(looseWrites(f, factoryTable).badTyping).toEqual(["fs.bin"]);
  });

  it("offsets are read the way people type them", () => {
    expect(parseOffset("0x20000")).toBe(0x20000);
    expect(parseOffset("128K")).toBe(0x20000);
    expect(parseOffset("1M")).toBe(0x100000);
    expect(parseOffset("factory", factoryTable)).toBe(0x10000);
    expect(parseOffset("20000")).toBe(null);
    expect(parseOffset("")).toBe(null);
  });
});

describe("release downloads", () => {
  for (const id of readIndex().devices) for (const r of readBundle(id).releases) {
    it(`${id} ${r.id}: the zip opens as the page opens it, and each .bin is its variant`, async () => {
      const { files } = releaseDownloads(id, r.id);
      const [z, ...bins] = files;
      expect(z.name).toBe(`${id}-firmware-${r.id}.zip`);
      const opened = await openPackageZip(z.data, allDevices());
      const bundled = readBundle(id);
      expect(opened.pkg).toEqual({ ...bundled, releases: [r] });
      for (const [i, v] of r.variants.entries()) {
        expect(bins[i].name).toBe(`${id}-firmware-${r.id}-${v.id}.bin`);
        expect(identify(bins[i].data).kind).toBe("merged");
        const c: PlanContext = { chip: deviceChip(bundled.device), flashBytes: bundled.device.flashSize, projects: bundled.device.projects };
        expect(checkPlan([{ name: bins[i].name, offset: 0, data: bins[i].data }], c)).toEqual([]);
        for (const p of v.parts) {
          const want = bytes(id, p.path);
          expect(Buffer.from(bins[i].data.subarray(p.offset, p.offset + p.size)).equals(want), p.path).toBe(true);
        }
      }
    });
  }

  it("are the same files every time", () => {
    const a = releaseDownloads("canary").files, b = releaseDownloads("canary").files;
    a.forEach((f, i) => expect(Buffer.from(f.data).equals(Buffer.from(b[i].data))).toBe(true));
  });

  // The GitHub release assets are exported on a laptop and the /downloads/ mirror is
  // built by CI, and both must be the same bytes. node:zlib broke that (Node 22 and 26
  // deflate differently). If this hash moves, the compressor has changed: every
  // published zip would stop matching its mirror, so pin it back rather than update it.
  it("deflate to the same bytes on any machine", () => {
    const data = new Uint8Array(70000).map((_, i) => (i * 2654435761) >>> 24 & (i % 7 ? 0xff : 0x0f));
    const z = zip([{ name: "manifest.json", data: new TextEncoder().encode('{"schema":2}') }, { name: "a/b.bin", data }], "2026-11-06");
    expect(createHash("sha256").update(z).digest("hex")).toBe("eaac2dad7acd2e1847e24163e780a4ba31dd69917768454f32a0f67848efab8d");
  });

  it("use only store and deflate, with no flags, as Burrow's extractor needs", async () => {
    const z = releaseDownloads("canary").files[0].data;
    const names = (await readZip(z)).map((e) => e.name);
    expect(names[0]).toBe("manifest.json");
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    for (let o = v.getUint32(z.length - 22 + 16, true), n = v.getUint16(z.length - 22 + 10, true); n > 0; n--) {
      expect([0, 8]).toContain(v.getUint16(o + 10, true));
      expect(v.getUint16(o + 8, true)).toBe(0);
      o += 46 + v.getUint16(o + 28, true) + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
    }
  });

  it("refuse a release that is not bundled", () => {
    expect(() => releaseDownloads("canary", "main-0000000")).toThrow(/no release main-0000000/);
  });

  it("a first-schema CANary zip (canary v0.2.0) still opens as a CANary's", async () => {
    const r = canary.releases[0];
    const legacy = { releases: [r] };
    const entries = [{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(legacy)) },
      ...r.variants.flatMap((v) => v.parts.map((p) => ({ name: p.path, data: bytes("canary", p.path) })))];
    const opened = await openPackageZip(zip(entries, r.date), allDevices());
    expect(opened.pkg.device.id).toBe("canary");
    expect(readPackage(legacy, []).pkg).toBe(null);
  });

  it("a zip with a part that does not match its checksum is refused", async () => {
    const r = canary.releases[0];
    const entries = [{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify({ ...canary, releases: [r] })) },
      ...r.variants.flatMap((v) => v.parts.map((p) => ({ name: p.path, data: bytes("canary", p.path) })))];
    entries[3].data = entries[3].data.slice();
    entries[3].data[100] ^= 1;
    await expect(openPackageZip(zip(entries, r.date), allDevices())).rejects.toThrow(/does not match its checksum/);
  });
});

describe("otadata", () => {
  it("computes the entry CRC the way the bootloader and otatool.py do", () => {
    for (const seq of [1, 2, 7, 0x12345678]) {
      const e = otadataEntry(seq);
      const want = crc32(e.subarray(0, 4), 0xffffffff) >>> 0; // otatool: binascii.crc32(seq, 0xFFFFFFFF)
      expect(new DataView(e.buffer).getUint32(28, true)).toBe(want);
    }
  });

  it("picks the valid entry with the higher sequence", () => {
    const d = new Uint8Array(0x2000).fill(0xff);
    expect(activeOtaSlot(d)).toEqual({ slot: 0, seq: null });
    d.set(otadataEntry(1), 0);
    expect(activeOtaSlot(d).slot).toBe(0);
    d.set(otadataEntry(2), 0x1000);
    expect(activeOtaSlot(d)).toEqual({ slot: 1, seq: 2 });
    d.set(otadataEntry(3), 0);
    expect(activeOtaSlot(d)).toEqual({ slot: 0, seq: 3 });
  });

  it("ignores an entry with a bad CRC or an invalid state", () => {
    const d = new Uint8Array(0x2000).fill(0xff);
    d.set(otadataEntry(1), 0);
    const corrupt = otadataEntry(2);
    corrupt[28] ^= 1;
    d.set(corrupt, 0x1000);
    expect(activeOtaSlot(d).slot).toBe(0);
    d.set(otadataEntry(2, 3 /* INVALID */), 0x1000);
    expect(activeOtaSlot(d).slot).toBe(0);
  });
});

describe("md5", () => {
  it("agrees with node:crypto on edge lengths and a real image", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const b = randomBytes(n);
      expect(md5hex(b), `len ${n}`).toBe(createHash("md5").update(b).digest("hex"));
    }
    const img = at(bundle(), 0x20000).data;
    expect(md5hex(img)).toBe(createHash("md5").update(img).digest("hex"));
  });
});

// Keep the compiler honest about the helper's type when nothing else names it.
export type { Chip };
