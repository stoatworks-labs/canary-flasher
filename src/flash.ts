// The only module that talks to hardware. Thin on purpose: esptool-js does the
// protocol; this decides what is allowed to reach it.

import { ESPLoader, Transport, type IEspLoaderTerminal } from "esptool-js";
import { DEFAULT_TABLE_OFFSET, TABLE_SIZE, chipByName, type Chip } from "./chips.ts";
import {
  PART_APP, SUB_OTA_0, activeOtaSlot, bootPartition, identify, otaSlot, otadataPartition, parsePartitionTable,
  type AppDescription, type Partition,
} from "./image.ts";
import { md5hex } from "./md5.ts";
import { checkPlan, type PlannedWrite } from "./plan.ts";

export interface DeviceInfo {
  /** What the ROM says it is. */
  chipName: string;
  /** The same, from the chip table; null for a chip this page does not flash. */
  chip: Chip | null;
  mac: string;
  flashBytes: number;
  flashLabel: string;
  /** The partition table on the unit, if it has one. */
  table: Partition[] | null;
  /** What the bootloader will boot, read off the unit's flash. */
  running: { partition: string; app: AppDescription | null } | null;
}

export interface WriteOptions {
  eraseAll: boolean;
  /** Project names an app must carry; unset for your own file. */
  projects?: readonly string[];
  /** The chip the firmware was chosen for; a different unit is refused. */
  expectChip?: string;
  /** The least flash the firmware's device has. */
  minFlash?: number;
  tableOffset?: number;
  onProgress: (done: number, total: number) => void;
}

/** Reasons the connected unit itself is wrong for the firmware, before any file is looked at. */
export function unitProblems(info: DeviceInfo, want: { chip?: string; minFlash?: number; name?: string }): string[] {
  const p: string[] = [];
  if (!info.chip) p.push(`this is an ${info.chipName}, which this page does not flash`);
  else if (want.chip && info.chip.name !== want.chip) p.push(`this is an ${info.chipName}, and ${want.name ?? "the firmware"} is for an ${want.chip}`);
  if (want.minFlash && info.flashBytes && info.flashBytes < want.minFlash) {
    p.push(`this unit has ${info.flashLabel} of flash, and ${want.name ?? "the firmware"} needs ${want.minFlash / 1024 / 1024}MB`);
  }
  if (!info.flashBytes) p.push("the unit did not say how much flash it has");
  return p;
}

export class Session {
  private constructor(
    private transport: Transport,
    private loader: ESPLoader,
    readonly port: SerialPort,
  ) {}

  static async open(port: SerialPort, log: (line: string) => void, baudrate = 921600): Promise<Session> {
    const terminal: IEspLoaderTerminal = {
      clean() {},
      writeLine: (d) => log(d),
      write: (d) => log(d),
    };
    const transport = new Transport(port, false);
    const loader = new ESPLoader({ transport, baudrate, terminal });
    try {
      await loader.main("default_reset");
    } catch (e) {
      await transport.disconnect().catch(() => {});
      throw e;
    }
    return new Session(transport, loader, port);
  }

  async describe(tableOffset = DEFAULT_TABLE_OFFSET): Promise<DeviceInfo> {
    const chipName = this.loader.chip.CHIP_NAME;
    const chip = chipByName(chipName) ?? null;
    const mac = await this.loader.chip.readMac(this.loader);
    const flashLabel = (await this.loader.detectFlashSize()) ?? "unknown";
    const flashBytes = flashLabel === "unknown" ? 0 : this.loader.flashSizeBytes(flashLabel as never);
    let table: Partition[] | null = null;
    let running: DeviceInfo["running"] = null;
    try {
      table = parsePartitionTable(await this.loader.readFlash(tableOffset, TABLE_SIZE));
      if (table) running = await this.running(table);
    } catch {
      // a blank or foreign unit: nothing to say, not an error
    }
    return { chipName, chip, mac, flashBytes, flashLabel, table, running };
  }

  private async running(table: Partition[]): Promise<DeviceInfo["running"]> {
    let part = bootPartition(table);
    const ota = otadataPartition(table);
    if (ota) {
      const slots = table.filter((p) => p.type === PART_APP && p.subtype >= SUB_OTA_0 && p.subtype < SUB_OTA_0 + 16).length;
      const { slot, seq } = activeOtaSlot(await this.loader.readFlash(ota.offset, Math.min(ota.size, 0x2000)), slots);
      if (seq !== null) part = otaSlot(table, slot) ?? part;
    }
    if (!part) return null;
    const info = identify(await this.loader.readFlash(part.offset, 0x200));
    return { partition: part.label, app: info.kind === "app" ? info.app : null };
  }

  async write(writes: PlannedWrite[], opts: WriteOptions): Promise<void> {
    const info = await this.describe(opts.tableOffset);
    const refused = unitProblems(info, { chip: opts.expectChip, minFlash: opts.minFlash });
    if (refused.length) throw new Error(refused.join("; "));
    const problems = checkPlan(writes, {
      chip: info.chip!,
      flashBytes: info.flashBytes,
      projects: opts.projects,
      unitTable: info.table,
      tableOffset: opts.tableOffset,
    });
    if (problems.length) throw new Error(problems.join("; "));

    const sizes = writes.map((w) => w.data.length);
    const total = sizes.reduce((s, n) => s + n, 0);
    const before = (i: number) => sizes.slice(0, i).reduce((s, n) => s + n, 0);
    await this.loader.writeFlash({
      fileArray: writes.map((w) => ({ data: w.data, address: w.offset })),
      // Never let esptool rewrite the bootloader header: a release already carries
      // its build's flash settings, and patching them would make the MD5 check
      // compare against bytes nobody built.
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
