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

Build from a clean export of the canary repo (it is private, at `~/hardware/audio/dbcanary`),
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

## Deploy

`.github/workflows/deploy.yml` deploys every push to `main`. It needs `CLOUDFLARE_API_TOKEN`
(repo secret) and `CLOUDFLARE_ACCOUNT_ID` (repo variable).
