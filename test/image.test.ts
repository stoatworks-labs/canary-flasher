import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { withOtadataReset } from "../src/flash.ts";
import { activeOtaSlot, checkPlan, identify, OFFSETS, otadataEntry, type PlannedWrite } from "../src/image.ts";
import { validateManifest, type Manifest } from "../src/manifest.ts";
import { md5hex } from "../src/md5.ts";

const FW = join(import.meta.dirname, "..", "public", "firmware");
const manifest: Manifest = JSON.parse(readFileSync(join(FW, "manifest.json"), "utf8"));
const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(join(FW, p)));
const MB8 = 8 * 1024 * 1024;

function bundle(variant = manifest.releases[0].variants[0]): PlannedWrite[] {
  return variant.parts.map((p) => ({ name: p.name, offset: p.offset, data: bytes(p.path) }));
}

describe("the committed manifest", () => {
  it("validates", () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("matches the files on disk, byte for byte", () => {
    for (const r of manifest.releases) for (const v of r.variants) for (const p of v.parts) {
      const data = bytes(p.path);
      expect(data.length, p.path).toBe(p.size);
      expect(createHash("sha256").update(data).digest("hex"), p.path).toBe(p.sha256);
    }
  });

  it("passes the same check the page runs before writing", () => {
    for (const r of manifest.releases) for (const v of r.variants) {
      expect(checkPlan(bundle(v), { flashBytes: MB8 }), `${r.id}/${v.id}`).toEqual([]);
    }
  });

  it("records the app descriptor that is really in the image", () => {
    for (const r of manifest.releases) for (const v of r.variants) {
      const app = v.parts.find((p) => p.offset === OFFSETS.app)!;
      const info = identify(bytes(app.path));
      expect(info.kind).toBe("app");
      if (info.kind === "app") expect(info.app).toEqual(v.app);
    }
  });

  it("rejects a manifest with a short commit or a missing bootloader", () => {
    const bad: Manifest = structuredClone(manifest);
    bad.releases[0].commit = "4bd1ac5";
    bad.releases[0].variants[0].parts = bad.releases[0].variants[0].parts.filter((p) => p.offset !== 0);
    const errors = validateManifest(bad);
    expect(errors.some((e) => e.includes("40-character"))).toBe(true);
    expect(errors.some((e) => e.includes("nothing at 0x0"))).toBe(true);
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

  it("calls random bytes and an empty file unknown", () => {
    const junk = randomBytes(4096);
    junk[0] = 0;
    expect(identify(junk).kind).toBe("unknown");
    expect(identify(new Uint8Array()).kind).toBe("unknown");
  });
});

describe("checkPlan refuses", () => {
  const good = (): PlannedWrite[] => bundle().map((w) => ({ ...w, data: w.data.slice() }));

  it("an app built for another chip", () => {
    const p = good();
    const app = p.find((w) => w.offset === OFFSETS.app)!;
    app.data[12] = 0; // chip id -> ESP32
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/built for ESP32,/);
  });

  it("an app from another project, unless overridden", () => {
    const p = good();
    const app = p.find((w) => w.offset === OFFSETS.app)!;
    app.data.set(new TextEncoder().encode("blinky\0\0"), 32 + 48);
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/"blinky", not a CANary/);
    expect(checkPlan(p, { flashBytes: MB8, allowForeign: true })).toEqual([]);
  });

  it("an app built before the rename, as dbcanary, is still ours", () => {
    const p = good();
    const app = p.find((w) => w.offset === OFFSETS.app)!;
    app.data.set(new TextEncoder().encode("dbcanary\0"), 32 + 48);
    expect(checkPlan(p, { flashBytes: MB8 })).toEqual([]);
  });

  it("overlapping writes", () => {
    const p = good();
    p.find((w) => w.offset === OFFSETS.otadata)!.offset = 0x8000; // onto the table
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/overlaps|sector/);
  });

  it("an app placed over the partition table", () => {
    const p = good().filter((w) => w.offset !== OFFSETS.partitionTable);
    p.find((w) => w.offset === OFFSETS.app)!.offset = 0x8000;
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/would overwrite the bootloader/);
  });

  it("a bootloader anywhere but 0x0", () => {
    const p = good().filter((w) => w.offset !== 0);
    p.push({ name: "bl", offset: 0x300000, data: bundle()[0].data });
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/only boots from 0x0/);
  });

  it("a unit with too little flash", () => {
    expect(checkPlan(good(), { flashBytes: 256 * 1024 }).join()).toMatch(/past the end of flash/);
  });

  it("an unaligned offset", () => {
    const p = good();
    p.find((w) => w.offset === OFFSETS.app)!.offset = 0x20010;
    expect(checkPlan(p, { flashBytes: MB8 }).join()).toMatch(/sector boundary/);
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

describe("withOtadataReset", () => {
  const app = bundle().find((w) => w.offset === OFFSETS.app)!;

  it("adds a blank otadata beside a lone app", () => {
    const { writes, added } = withOtadataReset([app]);
    expect(added).toBe(true);
    const ota = writes.find((w) => w.offset === OFFSETS.otadata)!;
    expect(ota.data.length).toBe(0x2000);
    expect(identify(ota.data).kind).toBe("otadata");
    expect(checkPlan(writes, { flashBytes: MB8 })).toEqual([]);
  });

  it("leaves a plan alone that already carries otadata", () => {
    expect(withOtadataReset(bundle()).added).toBe(false);
  });
});

describe("md5", () => {
  it("agrees with node:crypto on edge lengths and a real image", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const b = randomBytes(n);
      expect(md5hex(b), `len ${n}`).toBe(createHash("md5").update(b).digest("hex"));
    }
    const img = bundle()[3].data;
    expect(md5hex(img)).toBe(createHash("md5").update(img).digest("hex"));
  });
});
