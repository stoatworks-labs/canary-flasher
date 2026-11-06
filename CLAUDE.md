# CLAUDE.md — Stoatworks Flasher

Command reference. Read [AGENTS.md](AGENTS.md) first for the model and the traps, and
[docs/PACKAGE.md](docs/PACKAGE.md) for the firmware format.

## Commands

```bash
npm install
npm run dev          # vite dev server (writes public/downloads/ first)
npm test             # vitest, against the real bundled images
npm run build        # downloads, tsc -b && vite build -> dist/
npx tsc -b           # typecheck only
```

## Adding a device

Write `devices/<id>.json` (docs/PACKAGE.md says what goes in it), then import a build: the
importer adds the device to `public/firmware/index.json`. The tests pick it up on their own.

## Bundling a firmware release

Build from a clean export of the device's source, with a `version.txt` so the app descriptor
carries the release id (or, for a project that takes its version from `git describe`, from a
detached worktree at that commit):

```bash
git -C <source repo> archive <ref> firmware | tar -x -C <scratch>
echo main-<sha> > <scratch>/firmware/version.txt
# ESP-IDF 5.5.5: export IDF_PYTHON_ENV_PATH=~/.espressif/python_env/idf5.5_py3.12_env
idf.py -C <scratch>/firmware -B <abs build dir> -DSDKCONFIG=<abs build dir>/sdkconfig build
strings -n 6 <build>/*.bin | grep -E '/Users|/private'      # must print nothing
node scripts/import-firmware.ts --device <id> --build <build dir> --release main-<sha> --variant <id> \
  --name "…" --summary "…" --commit <full sha> --tag v<x.y.z> [--recommended] [--after "…"]
```

CANary's two variants: `-DSDKCONFIG_DEFAULTS="sdkconfig.defaults"` and
`"sdkconfig.defaults;sdkconfig.usb-ncm"`, from `canary-dev` at `~/hardware/audio/dbcanary`.
Cuckoo: build `bridge/` first (`cmake -S bridge -B bridge/build -G Ninja && cmake --build
bridge/build`), then `ui/` twice, the second with `-DCUCKOO_RP_FW=cuckoo_bridge`.

Then `npm test`. The suite re-hashes every file against the manifest.

## Publishing a release for Burrow and the downloads

Burrow downloads only from GitHub, and the page's links point there, so each bundled release
also goes on a release of the device's public repo (`repo` in its definition), made locally
(no workflow):

```bash
node scripts/export-release.ts --device <id> [--release main-<sha>] --out <dir>
gh release create v<x.y.z> -R <device repo> <dir>/*
```

The tag must be the release's `tag` in the manifest. To set one on a release that is already
bundled, or to copy in an edited `devices/<id>.json`, run the importer without `--build`:
`node scripts/import-firmware.ts --device <id> --release main-<sha> --tag v<x.y.z>`. A release
asset can't be replaced in place (Burrow's catalogue holds its sha256), so a repackaged release
gets a new tag. Check every asset's `digest` from
`gh api repos/<repo>/releases/tags/<tag>` against the sha256 the script prints, then
gen-downloads and gen-catalog-data in stoatworks-backend for the website and Burrow.

## Deploy

`.github/workflows/deploy.yml` deploys every push to `main`: the site as the Worker `flasher`
on the route `flasher.stoatworks-labs.com/*`, then the old address's redirect
(`redirect/wrangler.toml`, Worker `dbcanary-flasher`). It needs `CLOUDFLARE_API_TOKEN`
(repo secret) and `CLOUDFLARE_ACCOUNT_ID` (repo variable).
