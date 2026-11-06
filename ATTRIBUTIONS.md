# Attributions

Stoatworks Flasher is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### esptool-js

<https://github.com/espressif/esptool-js>  
Licence: Apache-2.0

An npm dependency, and what the flasher is built on, as its README says: src/flash.ts drives every flash through its ESPLoader over a Web Serial Transport.

### CANary firmware images — Stoatworks CANary

<https://github.com/stoatworks-labs/canary>  
Copyright: Stoatworks Labs

public/firmware/canary/ bundles two release builds of the CANary firmware, main-ff4110d (the default) and main-60a871f, each as a Standard and a USB network variant. Like every bundled image, they were imported from an ESP-IDF build directory by scripts/import-firmware.ts and are checked against published SHA-256s before they are shown. They are built from the CANary source and are not covered by this repository's MIT licence, which applies to the flasher itself.

### nanODE firmware images — Stoatworks Labs

<https://github.com/stoatworks-labs/nanode-firmware>  
Copyright: Stoatworks Labs

public/firmware/nanode/ bundles the nanODE release build main-622a72a. Its source is private: the images are free to flash and pass on unmodified under the Stoatworks Labs Firmware Licence, not this repository's MIT licence. They contain ESP-IDF and other third-party software, listed with each licence in that repository's THIRD-PARTY-NOTICES.md.

### Cuckoo firmware images — Stoatworks Labs

<https://github.com/stoatworks-labs/cuckoo-firmware>  
Copyright: Stoatworks Labs

public/firmware/cuckoo/ bundles the Cuckoo release build main-4300e74 in two variants, Bring-up and DDC bridge, each an ESP32-C3 image carrying the RP2354A's firmware. Its source is private: the images are free to flash and pass on unmodified under the Stoatworks Labs Firmware Licence, not this repository's MIT licence. They contain ESP-IDF, the Raspberry Pi Pico SDK and other third-party software, listed with each licence in that repository's THIRD-PARTY-NOTICES.md.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### fflate

<https://github.com/101arrowz/fflate>  
Licence: MIT  
Copyright: Arjun Barrett

An npm dependency.

Zip and deflate in plain JavaScript, fast enough to use in a browser. Office documents, OpenDocument files and most multi-file downloads are zip packages underneath.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
