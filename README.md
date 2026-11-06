> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author.
> **Not yet proven on a unit.** The image checks, the package format and the MD5 that verifies each
> write are covered by tests against every bundled image. I've driven the page in a browser as far as
> connecting, and no further. **Nothing has been flashed from it yet.**

# Stoatworks Flasher

A static web page that puts firmware on our hardware over USB, straight from a browser tab: the
[CANary](https://stoatworks-labs.com/hardware/canary/), [nanODE](https://stoatworks-labs.com/hardware/nanode/)
and [Cuckoo](https://stoatworks-labs.com/hardware/cuckoo/). It'll also put an image of your own on any
ESP32 board. You don't need to install a toolchain, a driver or Python first.

It's live at **<https://flasher.stoatworks-labs.com>**. It needs Web Serial, which means desktop Chrome,
Edge or Opera. It used to be the CANary Flasher, and its old address still works: it forwards here with
the CANary chosen.

There's more on [its page at stoatworks-labs.com](https://stoatworks-labs.com/web-tools/flasher/).

## What it does

| | |
|---|---|
| **Flash our firmware** | Pick a device, a release and a variant. Every part is checked against its published SHA-256 before it is shown. |
| **Flash your own file** | A release zip you downloaded earlier; a whole-flash image (esptool `merge-bin`, or one of the `.bin` downloads), which goes at 0x0; or the parts of an ESP-IDF build. Each file is identified by its **contents**, not its name, and put where its kind belongs. Anything it can't identify, a filesystem image say, waits for an offset you type (`0x3E0000`, `1M`, or a partition's name). A lone app gets a blank otadata written beside it, so the board boots what you just wrote rather than whatever it last updated to over the air. |
| **Say what the board is running** | On connect it reads the chip, MAC and flash size, the partition table, otadata and the booting app's descriptor, so you see the version before you overwrite it. A board running one of our devices' firmware picks that device for you. |
| **Downloads** | Every release is a **release zip** (its manifest and parts, which this page and Burrow both read) and a **whole-flash `.bin`** per variant. Download once, then reopen the file here, or write the `.bin` at 0x0 with esptool or Espressif's own tool. The links go to each device's GitHub release, pinned to its tag, with a copy on this site. |
| **Serial console** | Watch the board boot after flashing. |

## What it refuses

The page checks all of this before it writes anything (`checkPlan()` in [src/plan.ts](src/plan.ts)), and
the test suite runs the same checks over every bundled image:

- a chip it doesn't know, a chip other than the firmware's, or less flash than the device has;
- an image built for another chip;
- for one of our devices, an app whose project name isn't that device's;
- a bootloader anywhere but its chip's offset (0x1000 on the ESP32 and S2, 0x2000 on the C5, P4 and
  H4, 0x0 on the rest), or a partition table anywhere but 0x8000;
- an app that isn't at the start of an app partition, or doesn't fit in it; otadata anywhere but the
  otadata partition; data that doesn't start a data partition, unless you typed its offset;
- a partition table whose partitions overlap or run off the end of the flash;
- overlapping writes, offsets off a 4 KB sector, or anything past the end of flash.

A whole-flash image is checked as the pieces inside it. If the board already runs something other
than the firmware you're writing, you tick a box to say you mean it. Every write is then verified by
esptool's MD5 read-back.

## If a board will not connect

Each device's own steps are on the page once you pick it. In general: hold **BOOT** (or IO0), tap
**EN** or **RESET**, release **BOOT** and connect. An ESP32's boot ROM can't be overwritten, so you
can always recover a flash that fails half way like this.

## Bundled firmware

`public/firmware/<device>/` holds each device's releases and its `manifest.json`, and only
`scripts/import-firmware.ts` writes them. [docs/PACKAGE.md](docs/PACKAGE.md) is the format. The importer
reads a build's own `flasher_args.json`, so nobody types an offset by hand, checks the build against
the device's definition in `devices/<id>.json`, and refuses anything the page would refuse:

```bash
node scripts/import-firmware.ts --device <id> --build <idf build dir> --release main-<sha> \
  --variant standard --name "Standard" --summary "…" --commit <full sha> [--tag v1.2.3] --recommended
```

| Device | Chip | Releases | Proven |
|---|---|---|---|
| CANary | ESP32-S3 | main-ff4110d (default), main-60a871f | main-60a871f has run on a board (Ethernet and USB, acceptance test 19/19). main-ff4110d differs only in its names and hasn't been on a unit. |
| nanODE | ESP32 | main-622a72a | Builds clean and passes its host tests. No nanODE has been built, so it has never run. |
| Cuckoo | ESP32-C3 | main-4300e74, *Bring-up* and *DDC bridge* | The ESP32-C3 image has run on one board. The RP2354A images it carries haven't. |

The same files go on each device's GitHub releases for tools that write firmware themselves:
`scripts/export-release.ts` writes a release's zip and its whole-flash images, byte for byte the
ones this site serves.

The firmware images are built from each device's own source and **aren't** covered by this
repository's MIT licence, which applies to the flasher itself.

## Develop

```bash
npm install
npm run dev      # vite (builds public/downloads/ first)
npm test         # vitest
npm run build    # tsc -b && vite build -> dist/
```

It's built on [esptool-js](https://github.com/espressif/esptool-js) (Apache-2.0).

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->
