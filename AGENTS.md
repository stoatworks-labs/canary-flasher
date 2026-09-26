# AGENTS.md — dbCANary Flasher

Orientation for an AI assistant (or a new human) picking this up cold. `CLAUDE.md` is the
command reference.

## 1. What this is

A static page that flashes dbCANary firmware over Web Serial with esptool-js. Vite +
TypeScript, no framework, no backend. Firmware images are bundled under `public/firmware/`
and served beside the page.

## 2. Layout

```
src/image.ts      PURE. Identifies a .bin by its bytes, parses the partition table and
                  otadata, and checkPlan() — the one gate every write goes through.
src/manifest.ts   manifest types + validateManifest()
src/md5.ts        MD5 for esptool's write verification (Web Crypto has none)
src/flash.ts      the only module that touches hardware: Session wraps ESPLoader
src/main.ts       UI wiring
scripts/import-firmware.ts   the only writer of public/firmware/
test/             vitest, against the real bundled images
```

## 3. Invariants

- **Files are identified by content, never by name.** `identify()` decides what a file is;
  `defaultOffset()` decides where it goes.
- **`checkPlan()` is the gate.** The page runs it before enabling Flash and again inside
  `Session.write()` against the connected unit's real flash size. The import script runs it
  before a bundle can be committed, and the tests run it over every bundled variant.
  Loosening a rule loosens all of these at once.
- **Flash mode, frequency and size are always `keep`.** Letting esptool patch the bootloader
  header would make the MD5 verify compare against bytes nobody built.
- **A lone app at 0x20000 gets a blank otadata** (`withOtadataReset`). Without it, a unit that
  last updated over the air keeps booting ota_1, and the flash looks like it did nothing.
- **The ota_1 address (0x1F0000) is hard-coded** in `Session.describe()` from dbCANary's
  partition table. If that table ever changes, change it there too.

## 4. Naming

Public text (the page, the README, the website entry) never names the third-party product
the dbCANary stands in for, or its control application. Say "the control application".
The firmware binaries' own log strings are not page text.

## 5. Traps

- **The USB network image drops the serial port 8 s after boot** (the S3 has one USB PHY;
  TinyUSB takes it). After that, only BOOT+EN reaches the ROM. The page says so in three places.
- **Opening the port resets the unit** (USB-Serial-JTAG). A "passive" console still reboots it.
- **`-DSDKCONFIG_DEFAULTS` without `-DSDKCONFIG` is silently ignored** by idf.py. A USB
  network "build" made that way is a standard build. Check `CONFIG_TINYUSB_NET_MODE_NCM=y`
  in the build's own sdkconfig before importing it.
