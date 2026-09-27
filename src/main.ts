import "./style.css";
import { ESPRESSIF_VID, Session, withOtadataReset, type DeviceInfo } from "./flash.ts";
import { checkPlan, CHIP_NAMES, defaultOffset, hex, identify, type PlannedWrite } from "./image.ts";
import { validateManifest, type Manifest, type Release, type Variant } from "./manifest.ts";

declare const __APP_VERSION__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const w = window as unknown as { STOATWORKS_ABOUT?: Record<string, unknown> };
w.STOATWORKS_ABOUT = { ...w.STOATWORKS_ABOUT, version: __APP_VERSION__ };
$("version").textContent = `v${__APP_VERSION__}`;

// ---------------------------------------------------------------- state

let session: Session | null = null;
let device: DeviceInfo | null = null;
let busy = false;
let mode: "release" | "custom" = "release";
let manifest: Manifest | null = null;
let chosen: { release: Release; variant: Variant } | null = null;
let custom: PlannedWrite[] = [];
/** Resolved bytes for the plan on screen, or the reason there are none. */
let plan: { writes: PlannedWrite[]; notes: string[] } | { error: string } | null = null;

const logEl = $("log");
function log(line: string) {
  logEl.textContent += line.endsWith("\n") ? line : line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function status(text: string, tone: "" | "ok" | "err" = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + tone;
}

const hasSerial = "serial" in navigator;
if (!hasSerial) $("no-serial").hidden = false;

// ---------------------------------------------------------------- connect

$("connect").addEventListener("click", async () => {
  if (busy) return;
  let port: SerialPort;
  try {
    const any = ($("any-port") as HTMLInputElement).checked;
    port = await navigator.serial.requestPort(any ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch {
    return; // chooser dismissed
  }
  await closeConsole();
  busy = true;
  refresh();
  status("Connecting…");
  try {
    session = await Session.open(port, log);
    device = await session.describe();
    status(device.chip === "ESP32-S3" ? "Connected." : `Connected, but this is an ${device.chip}.`, device.chip === "ESP32-S3" ? "ok" : "err");
  } catch (e) {
    session = null;
    device = null;
    status(`Could not talk to the unit: ${message(e)}. If it runs the USB network firmware, see “No port listed” above.`, "err");
  }
  busy = false;
  renderDevice();
  refresh();
});

$("disconnect").addEventListener("click", async () => {
  await session?.close();
  session = null;
  device = null;
  renderDevice();
  status("");
  refresh();
});

function renderDevice() {
  const t = $<HTMLTableElement>("device");
  t.replaceChildren();
  t.hidden = !device;
  $("connect").hidden = !!device;
  $("disconnect").hidden = !device;
  if (!device) return;
  const row = (k: string, v: Node | string) => t.append(el("tr", {}, el("th", {}, k), el("td", {}, v)));
  const chipOk = device.chip === "ESP32-S3";
  row("Chip", el("span", { className: chipOk ? "good" : "bad" }, device.chip));
  row("MAC", device.mac);
  const flashOk = device.flashBytes >= 8 * 1024 * 1024;
  row("Flash", el("span", { className: flashOk ? "" : "bad" }, device.flashLabel + (flashOk ? "" : " (a CANary has 8MB)")));
  const r = device.running;
  row("Boots", !r ? "unknown (blank or unreadable)"
    : r.app ? `${r.app.project} ${r.app.version} from ota_${r.slot}, built ${r.app.date}`
    : `ota_${r.slot}, which holds no app image`);
}

// ---------------------------------------------------------------- firmware choice

for (const [id, m] of [["tab-release", "release"], ["tab-custom", "custom"]] as const) {
  $(id).addEventListener("click", () => {
    mode = m;
    $("tab-release").setAttribute("aria-selected", String(m === "release"));
    $("tab-custom").setAttribute("aria-selected", String(m === "custom"));
    $("pane-release").hidden = m !== "release";
    $("pane-custom").hidden = m !== "custom";
    void buildPlan();
  });
}

async function loadManifest() {
  try {
    const res = await fetch("/firmware/manifest.json", { cache: "no-cache" });
    const m = (await res.json()) as Manifest;
    const errors = validateManifest(m);
    if (errors.length) throw new Error(errors[0]);
    manifest = m;
  } catch (e) {
    $("release-meta").textContent = `The bundled releases could not be loaded (${message(e)}). Your own build still works.`;
    return;
  }
  const sel = $<HTMLSelectElement>("release");
  sel.replaceChildren(...manifest.releases.map((r, i) =>
    el("option", { value: r.id }, `${r.id} · ${r.date}${i === 0 ? " (latest)" : ""}`)));
  sel.addEventListener("change", renderVariants);
  renderVariants();
}

function renderVariants() {
  if (!manifest) return;
  const release = manifest.releases.find((r) => r.id === $<HTMLSelectElement>("release").value)!;
  $("release-meta").textContent = `Built from canary ${release.commit.slice(0, 7)} with ESP-IDF ${release.variants[0].app.idfVersion}.`;
  const keep = chosen?.release.id === release.id ? chosen.variant.id : null;
  const pick = release.variants.find((v) => v.id === keep) ?? release.variants.find((v) => v.recommended) ?? release.variants[0];
  $("variants").replaceChildren(...release.variants.map((v) => {
    const input = el("input", { type: "radio", name: "variant", value: v.id, checked: v === pick });
    input.addEventListener("change", () => { chosen = { release, variant: v }; void buildPlan(); });
    return el("label", { className: "card" }, input,
      el("span", {}, el("b", {}, v.name), ...(v.recommended ? [el("span", { className: "rec" }, "recommended")] : [])),
      el("p", {}, v.summary));
  }));
  chosen = { release, variant: pick };
  void buildPlan();
}

$("files").addEventListener("change", async () => {
  const files = [...($<HTMLInputElement>("files").files ?? [])];
  custom = [];
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const offset = defaultOffset(identify(data));
    custom.push({ name: f.name, offset: offset ?? -1, data });
  }
  void buildPlan();
});
$("allow-foreign").addEventListener("change", () => void buildPlan());

const cache = new Map<string, Uint8Array>();

async function fetchPart(path: string, sha256: string): Promise<Uint8Array> {
  const hit = cache.get(path);
  if (hit) return hit;
  const res = await fetch(`/firmware/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (x) => x.toString(16).padStart(2, "0")).join("");
  if (digest !== sha256) throw new Error(`${path} does not match its checksum`);
  cache.set(path, data);
  return data;
}

let planSeq = 0;
async function buildPlan() {
  const seq = ++planSeq;
  let next: typeof plan;
  if (mode === "release") {
    if (!chosen) next = null;
    else {
      try {
        const writes = await Promise.all(chosen.variant.parts.map(async (p) =>
          ({ name: p.name, offset: p.offset, data: await fetchPart(p.path, p.sha256) })));
        next = { writes, notes: [`Every part matched its published SHA-256 checksum.`] };
      } catch (e) {
        next = { error: message(e) };
      }
    }
  } else {
    const unknown = custom.filter((w) => w.offset < 0);
    if (!custom.length) next = null;
    else if (unknown.length) {
      next = { error: `${unknown.map((u) => u.name).join(", ")}: not an ESP-IDF image, partition table or otadata file` };
    } else {
      const { writes, added } = withOtadataReset(custom);
      next = { writes, notes: added ? ["A blank otadata is added so the unit boots the app you just wrote (ota_0), not whatever it last updated to over the air."] : [] };
    }
  }
  if (seq !== planSeq) return; // a newer choice won
  plan = next;
  renderPlan();
  refresh();
}

function renderPlan() {
  const t = $<HTMLTableElement>("plan");
  const body = t.tBodies[0];
  body.replaceChildren();
  const notes = $("plan-notes");
  notes.textContent = "";
  notes.className = "hint";
  if (!plan) { t.hidden = true; return; }
  if ("error" in plan) {
    t.hidden = true;
    notes.textContent = plan.error;
    notes.className = "hint status err";
    return;
  }
  t.hidden = false;
  for (const w of [...plan.writes].sort((a, b) => a.offset - b.offset)) {
    const info = identify(w.data);
    const what = info.kind === "app" ? `${info.app.project} ${info.app.version} · ${CHIP_NAMES[info.chipId] ?? "chip " + info.chipId}`
      : info.kind === "bootloader" ? `bootloader · ${CHIP_NAMES[info.chipId] ?? "chip " + info.chipId}`
      : info.kind === "partition-table" ? info.partitions.map((p) => p.label).join(", ")
      : info.kind === "otadata" ? "boot ota_0" : "";
    body.append(el("tr", {},
      el("td", {}, w.name),
      el("td", { className: "mono" }, hex(w.offset)),
      el("td", { className: "mono" }, kb(w.data.length)),
      el("td", {}, what)));
  }
  const refused = problems();
  notes.textContent = refused.length ? `Will not write this: ${refused.join("; ")}.` : plan.notes.join(" ");
  if (refused.length) notes.className = "hint status err";
}

// ---------------------------------------------------------------- flash

function problems(): string[] {
  if (!plan || "error" in plan) return [];
  return checkPlan(plan.writes, {
    flashBytes: device?.flashBytes || 8 * 1024 * 1024,
    allowForeign: mode === "custom" && $<HTMLInputElement>("allow-foreign").checked,
  });
}

function refresh() {
  const why = !hasSerial ? "Needs a browser with Web Serial."
    : !session ? "Connect a unit first."
    : device?.chip !== "ESP32-S3" ? "That is not an ESP32-S3."
    : !plan ? "Choose firmware."
    : "error" in plan ? "The firmware choice has a problem."
    : problems()[0] ?? "";
  const b = $<HTMLButtonElement>("flash");
  b.disabled = busy || why !== "";
  $("flash-why").textContent = busy ? "" : why;
  $<HTMLButtonElement>("connect").disabled = busy || !hasSerial;
  $<HTMLButtonElement>("disconnect").disabled = busy;
}

$("flash").addEventListener("click", async () => {
  if (!session || !plan || "error" in plan || busy) return;
  const eraseAll = $<HTMLInputElement>("erase-all").checked;
  busy = true;
  refresh();
  const bar = $("progress");
  const fill = bar.firstElementChild as HTMLElement;
  bar.hidden = false;
  fill.style.width = "0";
  status(eraseAll ? "Erasing the flash, then writing…" : "Writing…");
  const t0 = performance.now();
  try {
    await session.write(plan.writes, {
      eraseAll,
      allowForeign: mode === "custom" && $<HTMLInputElement>("allow-foreign").checked,
      onProgress: (done, total) => {
        fill.style.width = `${(100 * done) / total}%`;
        status(`Writing… ${kb(done)} of ${kb(total)}`);
      },
    });
    fill.style.width = "100%";
    status("Written and verified. Rebooting the unit…");
    await session.resetAndClose();
    session = null;
    device = null;
    renderDevice();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const usbnet = mode === "release" && chosen?.variant.id === "usb-network";
    status(`Done in ${secs} s. The unit has rebooted into the new firmware.` +
      (usbnet ? " In 8 s its USB-C port becomes a network adapter. The settings page is at http://192.168.7.1/." : " Open the console below to watch it boot."), "ok");
  } catch (e) {
    status(`Flashing stopped: ${message(e)}. The unit is recoverable: hold BOOT, tap EN, reconnect and flash again.`, "err");
    log(`ERROR: ${message(e)}`);
  }
  busy = false;
  refresh();
});

// ---------------------------------------------------------------- console

let consolePort: SerialPort | null = null;
let consoleReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
const term = $("console");

$("console-open").addEventListener("click", async () => {
  if (session) {
    status("Disconnect the flasher first. The console and the flasher cannot share the port.", "err");
    return;
  }
  try {
    const known = (await navigator.serial.getPorts()).find((p) => p.getInfo().usbVendorId === ESPRESSIF_VID);
    consolePort = known ?? await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
    await consolePort.open({ baudRate: 115200 });
  } catch (e) {
    if (consolePort) term.textContent += `\n[could not open: ${message(e)}]\n`;
    consolePort = null;
    return;
  }
  $("console-open").hidden = true;
  $("console-close").hidden = false;
  term.textContent += "[console open]\n";
  const decoder = new TextDecoder();
  try {
    while (consolePort?.readable) {
      consoleReader = consolePort.readable.getReader();
      for (;;) {
        const { value, done } = await consoleReader.read();
        if (done) break;
        // ANSI colour codes from ESP_LOG are noise in a <pre>.
        term.textContent += decoder.decode(value, { stream: true }).replace(/\x1b\[[0-9;]*m/g, "");
        if (term.textContent!.length > 200_000) term.textContent = term.textContent!.slice(-150_000);
        term.scrollTop = term.scrollHeight;
      }
      consoleReader.releaseLock();
      consoleReader = null;
    }
  } catch {
    term.textContent += "\n[port went away. The unit reset, or its USB-C port became a network adapter]\n";
  }
  await closeConsole();
});

$("console-close").addEventListener("click", () => void closeConsole());
$("console-clear").addEventListener("click", () => { term.textContent = ""; });

async function closeConsole() {
  const port = consolePort;
  consolePort = null;
  try { await consoleReader?.cancel(); } catch { /* already gone */ }
  consoleReader = null;
  try { await port?.close(); } catch { /* already gone */ }
  $("console-open").hidden = false;
  $("console-close").hidden = true;
}

// ---------------------------------------------------------------- helpers

function kb(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

void loadManifest();
refresh();
