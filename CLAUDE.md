# CLAUDE.md — CANary Flasher

Command reference. Read [AGENTS.md](AGENTS.md) first for the model and the traps.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest, against the real bundled images
npm run build        # tsc -b && vite build -> dist/
npx tsc -b           # typecheck only
```

## Bundling a firmware release

Build from a clean export of the private `canary-dev` repo (at `~/hardware/audio/dbcanary`),
with a `version.txt` so the app descriptor carries the release id:

```bash
git -C ~/hardware/audio/dbcanary archive <ref> firmware | tar -x -C <scratch>
echo main-<sha> > <scratch>/firmware/version.txt
# ESP-IDF 5.5.5: export IDF_PYTHON_ENV_PATH=~/.espressif/python_env/idf5.5_py3.12_env
idf.py -B out-standard -DSDKCONFIG=out-standard/sdkconfig -DSDKCONFIG_DEFAULTS="sdkconfig.defaults" build
idf.py -B out-usbnet  -DSDKCONFIG=out-usbnet/sdkconfig  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.usb-ncm" build
node scripts/import-firmware.ts --build <scratch>/firmware/out-standard --release main-<sha> --variant standard ...
```

Then `npm test`. The suite re-hashes every file against the manifest.

## Publishing a release for Burrow

Burrow downloads only from GitHub, so each bundled release also goes on a release of the
public `stoatworks-labs/canary` repo, made locally (no workflow):

```bash
node scripts/export-release.ts [--release main-<sha>] [--out <dir>]   # default: the first release
gh release create v<x.y.z> -R stoatworks-labs/canary <dir>/canary-firmware-main-<sha>.zip ...
```

The zip holds `manifest.json` (a Manifest with just that release, paths unchanged) and the parts,
byte for byte. Check the asset's `digest` from `gh api` against the sha256 the script prints.

## Deploy

`.github/workflows/deploy.yml` deploys every push to `main`. It needs `CLOUDFLARE_API_TOKEN`
(repo secret) and `CLOUDFLARE_ACCOUNT_ID` (repo variable).
