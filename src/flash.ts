// The only module that talks to hardware. Thin on purpose: esptool-js does the
// protocol; this decides what is allowed to reach it.

import { ESPLoader, Transport, type IEspLoaderTerminal } from "esptool-js";
import { activeOtaSlot, checkPlan, identify, OFFSETS, type AppDescription, type PlannedWrite } from "./image.ts";
import { md5hex } from "./md5.ts";

/** Espressif's USB VID. The S3's built-in USB-Serial-JTAG enumerates as 303a:1001. */
export const ESPRESSIF_VID = 0x303a;

export interface DeviceInfo {
  chip: string;
  mac: string;
  flashBytes: number;
  flashLabel: string;
  /** What the bootloader will boot, read off the unit's flash. */
  running: { slot: number; app: AppDescription | null } | null;
}

export class Session {
  private constructor(
    private transport: Transport,
    private loader: ESPLoader,
    readonly port: SerialPort,
  ) {}

  static async open(port: SerialPort, log: (line: string) => void): Promise<Session> {
    const terminal: IEspLoaderTerminal = {
      clean() {},
      writeLine: (d) => log(d),
      write: (d) => log(d),
    };
    const transport = new Transport(port, false);
    const loader = new ESPLoader({ transport, baudrate: 921600, terminal });
    try {
      await loader.main("default_reset");
    } catch (e) {
      await transport.disconnect().catch(() => {});
      throw e;
    }
    return new Session(transport, loader, port);
  }

  async describe(): Promise<DeviceInfo> {
    const chip = this.loader.chip.CHIP_NAME;
    const mac = await this.loader.chip.readMac(this.loader);
    const flashLabel = (await this.loader.detectFlashSize()) ?? "unknown";
    const flashBytes = flashLabel === "unknown" ? 0 : this.loader.flashSizeBytes(flashLabel as never);
    let running: DeviceInfo["running"] = null;
    try {
      const otadata = await this.loader.readFlash(OFFSETS.otadata, 0x2000);
      const { slot } = activeOtaSlot(otadata);
      // ota_0 at 0x20000, ota_1 right after it — dbCANary's table since rev A.
      const base = slot === 0 ? 0x20000 : 0x1f0000;
      const head = await this.loader.readFlash(base, 0x200);
      const info = identify(head);
      running = { slot, app: info.kind === "app" ? info.app : null };
    } catch {
      running = null; // a blank or foreign unit: nothing to say, not an error
    }
    return { chip, mac, flashBytes, flashLabel, running };
  }

  async write(
    writes: PlannedWrite[],
    opts: { eraseAll: boolean; allowForeign: boolean; onProgress: (done: number, total: number) => void },
  ): Promise<void> {
    const info = await this.describe();
    if (info.chip !== "ESP32-S3") throw new Error(`this is an ${info.chip}; a dbCANary is an ESP32-S3`);
    const problems = checkPlan(writes, { flashBytes: info.flashBytes, allowForeign: opts.allowForeign });
    if (problems.length) throw new Error(problems.join("; "));

    const sizes = writes.map((w) => w.data.length);
    const total = sizes.reduce((s, n) => s + n, 0);
    const before = (i: number) => sizes.slice(0, i).reduce((s, n) => s + n, 0);
    await this.loader.writeFlash({
      fileArray: writes.map((w) => ({ data: w.data, address: w.offset })),
      // Never let esptool rewrite the bootloader header: the bundled images
      // already carry the build's flash settings, and patching them would make
      // the MD5 check compare against bytes nobody built.
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: opts.eraseAll,
      compress: true,
      // Progress arrives in compressed bytes; scale each file to its real size.
      reportProgress: (i, written, fileTotal) =>
        opts.onProgress(before(i) + Math.round((written / Math.max(fileTotal, 1)) * sizes[i]), total),
      calculateMD5Hash: md5hex,
    });
  }

  /** Reboot into the new firmware and let go of the port. */
  async resetAndClose(): Promise<void> {
    try {
      await this.loader.after("hard_reset");
    } finally {
      await this.transport.disconnect().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.transport.disconnect().catch(() => {});
  }
}

/**
 * A lone app image boots only if otadata points at the slot it went into.
 * When the plan writes an app to ota_0 and says nothing about otadata, add a
 * blank one — the bootloader reads that as "boot ota_0". Without it, a unit
 * that last updated over the air keeps booting ota_1 and the flash looks like
 * it did nothing.
 */
export function withOtadataReset(writes: PlannedWrite[]): { writes: PlannedWrite[]; added: boolean } {
  const hasApp0 = writes.some((w) => w.offset === OFFSETS.app);
  const hasOtadata = writes.some((w) => w.offset === OFFSETS.otadata);
  if (!hasApp0 || hasOtadata) return { writes, added: false };
  return {
    writes: [...writes, { name: "otadata (blank — boot ota_0)", offset: OFFSETS.otadata, data: new Uint8Array(0x2000).fill(0xff) }],
    added: true,
  };
}
