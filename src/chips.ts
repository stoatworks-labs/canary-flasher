// The ESP32 family as far as flashing cares: what each chip is called, the id its
// images carry, and where its bootloader goes. Pure data, shared by the page, the
// scripts and the tests.
//
// `name` is esptool-js's CHIP_NAME, which is what a connected unit reports, so the
// two can be compared as strings. `imageId` is `esp_chip_id_t`, bytes 12–13 of every
// ESP-IDF image's extended header. `bootloader` is the chip's
// BOOTLOADER_FLASH_OFFSET: the classic ESP32 and the S2 boot from 0x1000, the C5,
// P4 and H4 from 0x2000, the rest from 0x0.

export interface Chip {
  name: string;
  imageId: number;
  bootloader: number;
}

export const CHIPS: readonly Chip[] = [
  { name: "ESP32", imageId: 0, bootloader: 0x1000 },
  { name: "ESP32-S2", imageId: 2, bootloader: 0x1000 },
  { name: "ESP32-C3", imageId: 5, bootloader: 0x0 },
  { name: "ESP32-S3", imageId: 9, bootloader: 0x0 },
  { name: "ESP32-C2", imageId: 12, bootloader: 0x0 },
  { name: "ESP32-C6", imageId: 13, bootloader: 0x0 },
  { name: "ESP32-H2", imageId: 16, bootloader: 0x0 },
  { name: "ESP32-P4", imageId: 18, bootloader: 0x2000 },
  { name: "ESP32-C61", imageId: 20, bootloader: 0x0 },
  { name: "ESP32-C5", imageId: 23, bootloader: 0x2000 },
  { name: "ESP32-H4", imageId: 28, bootloader: 0x2000 },
];

export function chipByName(name: string): Chip | undefined {
  return CHIPS.find((c) => c.name === name);
}

export function chipByImageId(id: number): Chip | undefined {
  return CHIPS.find((c) => c.imageId === id);
}

/** A readable name for an image's chip id, even one this table does not know. */
export function chipLabel(imageId: number): string {
  return chipByImageId(imageId)?.name ?? `chip id ${imageId}`;
}

/** Where ESP-IDF puts the partition table unless CONFIG_PARTITION_TABLE_OFFSET moves it. */
export const DEFAULT_TABLE_OFFSET = 0x8000;
/** The table's partition: 0xC00 bytes of entries and the MD5 entry, padded to a sector. */
export const TABLE_SIZE = 0xc00;

/**
 * USB vendor ids the port chooser lists by default: Espressif's own USB
 * (USB-Serial/JTAG and the S2/S3 OTG ROM), and the USB-to-UART bridges ESP32
 * boards use. A board on anything else is still reachable with "show every port".
 */
export const SERIAL_VIDS = [
  0x303a, // Espressif
  0x10c4, // Silicon Labs CP210x
  0x1a86, // WCH CH340/CH343/CH9102
  0x0403, // FTDI
];
