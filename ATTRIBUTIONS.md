# Attributions

CANary Flasher is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### esptool-js

<https://github.com/espressif/esptool-js>  
Licence: Apache-2.0

An npm dependency, and what the flasher is built on, as its README says: src/flash.ts drives every flash through its ESPLoader over a Web Serial Transport.

### CANary firmware images — Stoatworks canary

<https://github.com/stoatworks-labs/canary>  
Copyright: Stoatworks Labs

public/firmware/ bundles two release builds of the CANary firmware, main-ff4110d (the default) and main-60a871f, each as a Standard and a USB network variant, imported from an ESP-IDF build directory by scripts/import-firmware.ts and checked against published SHA-256s before they are shown. They are built from the CANary source and are not covered by this repository's MIT licence, which applies to the flasher itself.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

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
