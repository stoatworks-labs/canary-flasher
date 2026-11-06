# Firmware packages (schema 2)

One format, read by this page and by Burrow, for putting an ESP-IDF build on one of our
devices. `src/package.ts` is the reference: its types, `validatePackage()` and
`readPackage()`. `src/plan.ts`'s `checkPlan()` is the check that runs on the bytes.
Change either and Burrow's port (`crates/burrow-device/src/esp/`) changes with it.

## Where packages live

```
public/firmware/index.json                         { "schema": 2, "devices": ["canary", ...] }
public/firmware/<device>/manifest.json             a Package: the device and every bundled release
public/firmware/<device>/<release>/<variant>/<file>
```

A **release zip**, `<device>-firmware-<release>.zip`, is one release cut out of that
directory: `manifest.json` (a Package whose `releases` holds just that release) and the
parts at the same relative paths. It is a GitHub release asset on `device.repo`, pinned to
the release's `tag`, and the page mirrors it at `/downloads/<device>/`. Entries are stored
or deflated, with no zip64, no data descriptors and no directory entries.

A **whole-flash image**, `<device>-firmware-<release>-<variant>.bin`, is one variant's
parts laid end to end from 0x0, gaps filled with 0xFF, as `esptool merge-bin` makes it.
Written at 0x0 it is the same flash as the parts written one by one.

Both are generated (`scripts/lib.ts`, `releaseDownloads()`) and the same bytes every time,
so a published asset's GitHub digest can be checked against a fresh export.

## manifest.json

```jsonc
{
  "schema": 2,
  "device": {
    "id": "canary",                 // lower case; directory name and download prefix
    "name": "CANary",
    "chip": "ESP32-S3",             // esptool's CHIP_NAME
    "flashSize": 8388608,           // bytes every unit has; a unit with less is refused
    "projects": ["canary", "dbcanary"],   // esp_app_desc_t.project_name values that are this device's
    "repo": "stoatworks-labs/canary",     // public repo carrying the release zips (optional)
    "page": "https://stoatworks-labs.com/hardware/canary/",   // optional
    "status": "…",                  // how proven the firmware is, said where it is offered (optional)
    "usb": [{ "vendorId": 12346, "productId": 4097, "label": "USB JTAG/serial debug unit" }],
    "connect": ["…", "…"],          // steps to get it talking (optional)
    "notes": ["…"],                 // "it will not connect" paragraphs (optional)
    "bootMode": ["…", "…"],         // steps to force download mode (optional)
    "keeps": "…",                   // what an ordinary (no full erase) flash leaves alone (optional)
    "tableOffset": 32768,           // only when CONFIG_PARTITION_TABLE_OFFSET is not 0x8000
    "baud": 460800                  // flashing speed, when 921600 is too fast for the wiring (optional)
  },
  "releases": [                     // newest first; the first is the default
    {
      "id": "main-ff4110d",         // the firmware build; parts sit under <id>/
      "tag": "v0.2.1",              // the GitHub release carrying its downloads (optional)
      "date": "2026-09-27",
      "commit": "<40 hex>",         // the firmware source it was built from
      "notes": "…",                 // optional
      "variants": [
        {
          "id": "standard",
          "name": "Standard",
          "summary": "…",
          "recommended": true,      // optional
          "after": "…",             // shown once the unit has rebooted into it (optional)
          "app": { "version": "…", "project": "canary", "time": "…", "date": "…", "idfVersion": "v5.5.5" },
          "parts": [
            { "name": "bootloader", "offset": 0, "path": "main-ff4110d/standard/bootloader.bin",
              "size": 20928, "sha256": "<64 hex>" }
          ]
        }
      ]
    }
  ]
}
```

Without the bytes, a package must have: a known chip; a power-of-two `flashSize` of at
least 1 MB; at least one project name; unique release and variant ids; a full commit; and in
every variant a part at the chip's bootloader offset, a part at the table offset, at least
three parts, each on a 4 KB boundary, with a size and a SHA-256, at a path under
`<release>/<variant>/`. Every variant's `app.project` is one of the device's.

The **first schema** (canary v0.2.0's zip) is a bare `{ "releases": [...] }` with no
`schema` and no `device`. A reader takes the first device it knows whose `projects` cover
every variant's app, and refuses the zip if none does.

## What the bytes must be (checkPlan)

Everything is identified by content, never by name:

| Bytes | Is |
|---|---|
| 0xE9 at 0x0 (or at 0x1000/0x2000 behind 0xFF, for the chips that boot there) **and** a partition table at 0x8000 | a whole-flash image |
| 0xE9 at 0, `esp_app_desc_t` magic 0xABCD5432 at 32 | an app; chip id is bytes 12–13 |
| 0xE9 at 0, no app descriptor | a bootloader |
| 32-byte entries starting 0xAA 0x50 | a partition table |
| exactly 8 KB of 0xFF | blank otadata |
| anything else | data |

A whole-flash image is checked as its pieces: the bootloader, the table, and every
partition in that table that is not blank.

Refused:

- an offset off a 4 KB boundary; anything past the end of flash; overlapping writes;
- an image whose chip id is not the unit's chip;
- a bootloader anywhere but the chip's offset (0x1000 for the ESP32 and S2, 0x2000 for the
  C5, P4 and H4, 0x0 otherwise); a table anywhere but the table offset;
- a table whose partitions overlap, run past the flash, sit below the table, put an app off
  a 64 KB boundary, or have no app partition;
- an app not at the start of an app partition, or bigger than it, by the table the plan
  writes (or, if it writes none, the table read off the unit); an app with no table at all;
- otadata anywhere but the otadata partition;
- data that does not start a data partition and fit in it, unless the person typed its
  offset (a raw write);
- for a device, an app whose project is not one of the device's.

A plan that writes an app to the partition a blank otadata boots (factory if there is one,
else ota_0) and leaves otadata alone gets a blank otadata added, so a unit that last updated
over the air does not go on booting its other slot.

## Making one

```bash
node scripts/import-firmware.ts --device <id> --build <idf build dir> --release <id> \
  --variant <id> --name "…" --summary "…" --commit <full sha> [--tag vX.Y.Z] [--recommended] \
  [--after "…"] [--extra 0x<offset>=<file>]
node scripts/export-release.ts --device <id> [--release <id>] --out <dir>
gh release create <tag> -R <device.repo> <dir>/*
```

The importer reads the build's `flasher_args.json`, so offsets are never typed by hand,
checks the chip and flash size against `devices/<id>.json`, and copies that definition into
the manifest. Edit the device there.
