import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportRelease } from "../scripts/export-release.ts";
import { validateManifest, type Manifest } from "../src/manifest.ts";

const FW = join(import.meta.dirname, "..", "public", "firmware");
const bundled: Manifest = JSON.parse(readFileSync(join(FW, "manifest.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "canary-export-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();

/** Compression method and flags of every central directory entry. */
function methods(z: Uint8Array): { name: string; method: number; flags: number }[] {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const end = z.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const out = [];
  for (let at = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); n > 0; n--) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const nameLen = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(z.subarray(at + 46, at + 46 + nameLen));
    out.push({ name, method: v.getUint16(at + 10, true), flags: v.getUint16(at + 8, true) });
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

describe("export-release", () => {
  it("defaults to the page's default release", () => {
    expect(exportRelease(FW).name).toBe(`canary-firmware-${bundled.releases[0].id}.zip`);
  });

  it.each(bundled.releases.map((r) => r.id))("round-trips %s through unzip and validateManifest", (id) => {
    const { name, data } = exportRelease(FW, id);
    const zipPath = join(scratch, name);
    writeFileSync(zipPath, data);
    const out = join(scratch, id);
    execFileSync("unzip", ["-q", zipPath, "-d", out]);

    const m: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(validateManifest(m)).toEqual([]);
    expect(m).toEqual({ releases: [bundled.releases.find((r) => r.id === id)] });

    const paths = m.releases[0].variants.flatMap((v) => v.parts.map((p) => p.path));
    expect(files(out)).toEqual(["manifest.json", ...paths].sort());
    for (const p of m.releases[0].variants.flatMap((v) => v.parts)) {
      const got = readFileSync(join(out, p.path));
      expect(got.length, p.path).toBe(p.size);
      expect(createHash("sha256").update(got).digest("hex"), p.path).toBe(p.sha256);
      expect(got.equals(readFileSync(join(FW, p.path))), p.path).toBe(true);
    }
  });

  it("uses only store and deflate, with no flags, as Burrow's extractor needs", () => {
    const entries = methods(exportRelease(FW).data);
    expect(entries[0].name).toBe("manifest.json");
    for (const e of entries) {
      expect([0, 8], e.name).toContain(e.method);
      expect(e.flags, e.name).toBe(0);
    }
  });

  it("is the same file every time", () => {
    expect(Buffer.from(exportRelease(FW).data).equals(Buffer.from(exportRelease(FW).data))).toBe(true);
  });

  it("refuses a release that is not bundled", () => {
    expect(() => exportRelease(FW, "main-0000000")).toThrow(/no release main-0000000/);
  });
});
