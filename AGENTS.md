# AGENTS.md — Stoatworks Flasher

Orientation for an AI assistant (or a new human) picking this up cold. `CLAUDE.md` is the
command reference, `docs/PACKAGE.md` the firmware package format.

## 1. What this is

A static page that flashes ESP32 firmware over Web Serial with esptool-js: our devices'
releases, or any image someone brings. Vite + TypeScript, no framework, no backend. Firmware
is bundled under `public/firmware/` and served beside the page. It was CANary Flasher until
2026-11-06; the old address forwards from `redirect/`.

Burrow writes the same packages natively (`crates/burrow-device/src/esp/` in the burrow repo,
a Rust port of `src/image.ts`, `src/plan.ts` and `src/package.ts`). A format change is a change
to both.

## 2. Layout

```
src/chips.ts      the ESP32 family: CHIP_NAME, image chip id, bootloader offset
src/image.ts      PURE. identify() by bytes (app, bootloader, table, otadata, whole-flash),
                  the partition table and otadata
src/plan.ts       PURE. checkPlan(), the one gate every write goes through; components(),
                  withOtadataReset(), mergeParts()
src/package.ts    the package format: types, validatePackage(), readPackage(), download names
src/files.ts      a release zip or loose files -> a plan
src/zip.ts        reading zips in the page
src/md5.ts        MD5 for esptool's write verification (Web Crypto has none)
src/flash.ts      the only module that touches hardware: Session wraps ESPLoader
src/main.ts       UI wiring
devices/<id>.json each device's definition; the importer copies it into the manifest
scripts/import-firmware.ts   the only writer of public/firmware/
scripts/export-release.ts    a release's zip and whole-flash .bins, for its GitHub release
scripts/downloads.ts         the same into public/downloads/ (generated, gitignored)
redirect/         the old canary-flasher address, a 301 Worker
test/             vitest, against the real bundled images
```

## 3. Invariants

- **Files are identified by content, never by name.** `identify()` decides what a file is;
  the chip and the partition table decide where it goes.
- **`checkPlan()` is the gate.** The page runs it before enabling Flash and again inside
  `Session.write()` against the connected unit. The importer and the exporter run it, and the
  tests run it over every bundled variant. Loosening a rule loosens all of these at once.
- **Offsets come from the chip and the partition table, never constants.** The bootloader's is
  the chip's; apps, otadata and data images go where the table says (the plan's own table, else
  the one read off the unit).
- **The project check is for our devices only.** Your own file is checked for chip, geometry and
  layout, not for whose it is. Overwriting different firmware than the unit runs needs a tick.
- **Flash mode, frequency and size are always `keep`.** Letting esptool patch the bootloader
  header would make the MD5 verify compare against bytes nobody built.
- **Downloads are the same bytes every time.** The zip writer pins its dates and order, and the
  test suite checks it. A GitHub asset's digest must match a fresh export; if it doesn't, the
  release was re-cut and Burrow's catalogue sha256 is wrong.
- **Firmware URLs are pinned to the release tag**, never latest/download.

## 4. Naming

Public text (the page, the README, the website entry) never names the third-party product the
CANary stands in for, its model numbers, or its control application. That includes a model number
hiding in a default device name. Say "the control application", and "the d&b amplifier ecosystem"
where compatibility needs saying. `dbcanary`, the pre-rename project name, is vendor-level and
stays wherever the page has to accept it. The firmware binaries' own log strings are not page text.

## 5. Firmware sources and their posture

| Device | Source (private unless said) | Public downloads |
|---|---|---|
| canary | `stoatworks-labs/canary-dev` at `~/hardware/audio/dbcanary`; `stoatworks-labs/canary` is its public, hand-redacted export | releases on `stoatworks-labs/canary` |
| nanode | `stoatworks-labs/nanODE` at `~/hardware/lighting/nanODE` | binaries only, on `stoatworks-labs/nanode-firmware` |
| cuckoo | `stoatworks-labs/cuckoo` at `~/hardware/video/cuckoo` | binaries only, on `stoatworks-labs/cuckoo-firmware` |

Build from a clean export or a detached worktree of the source, never from a working copy with
local edits, and check the binaries with `strings` for local paths (`/Users`, `/private`) before
importing. ESP-IDF's `CONFIG_COMPILER_HIDE_PATHS_MACROS` hides the IDF and project paths, but not
a component outside the project directory.

## 6. Traps

- **CANary's USB network image drops the serial port 8 s after boot** (the S3 has one USB PHY;
  TinyUSB takes it). After that, only BOOT+EN reaches the ROM. Its device definition says so.
- **Opening a USB-Serial/JTAG port resets the unit.** A "passive" console still reboots it.
- **`-DSDKCONFIG_DEFAULTS` without `-DSDKCONFIG` is silently ignored** by idf.py. A CANary USB
  network "build" made that way is a standard build. Check `CONFIG_TINYUSB_NET_MODE_NCM=y` in the
  build's own sdkconfig before importing it.
- **`-DSDKCONFIG` wants an absolute path** with `idf.py -C <dir>`: a relative one is taken from
  the project directory and kconfgen fails writing it.
- **nanODE has no USB socket**: it is flashed through a 3.3 V adapter on the module's
  castellations, at 460800 (`baud` in its definition).
- **Cuckoo's two variants differ only in rp_fw** (the RP2354A image the ESP32 carries) and in the
  app's build time.
