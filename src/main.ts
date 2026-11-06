import "./style.css";
import { SERIAL_VIDS, chipByImageId, type Chip } from "./chips.ts";
import { looseWrites, openPackageZip, placeFiles, sha256hex, variantWrites, type LooseFile, type OpenedPackage } from "./files.ts";
import { Session, unitProblems, type DeviceInfo } from "./flash.ts";
import { describeImage, hex } from "./image.ts";
import {
  deviceChip, githubAsset, mergedName, readPackage, zipName,
  type BundleIndex, type DeviceDef, type Package, type Part, type Release, type Variant,
} from "./package.ts";
import { checkPlan, components, planNotes, withOtadataReset, type PlanContext, type PlannedWrite } from "./plan.ts";
import { isZip } from "./zip.ts";

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

/** What the chosen firmware asks of the unit it goes on. */
interface Want {
  device: DeviceDef | null;
  chip: Chip | null;
  projects?: readonly string[];
  minFlash?: number;
  tableOffset?: number;
  after?: string;
}

let session: Session | null = null;
let unit: DeviceInfo | null = null;
let busy = false;
let mode: "release" | "file" = "release";
let bundle: Package[] = [];
let deviceId: string | null = new URLSearchParams(location.search).get("device");
let pick: { release: Release; variant: Variant } | null = null;
let opened: OpenedPackage | null = null;
let filePick: { release: Release; variant: Variant } | null = null;
let loose: LooseFile[] = [];
/** Resolved bytes for the plan on screen, or the reason there are none. */
let plan: { writes: PlannedWrite[]; notes: string[]; want: Want } | { error: string } | null = null;
let downloadsIndex: Record<string, Record<string, { name: string; size: number; sha256: string }[]>> = {};

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

const currentDevice = (): Package | undefined => bundle.find((p) => p.device.id === deviceId);
/** The device whose instructions apply: the chosen one, or the one an opened zip is for. */
const helpDevice = (): DeviceDef | null => (mode === "file" ? opened?.pkg.device ?? null : currentDevice()?.device ?? null);

// ---------------------------------------------------------------- connect

const defaults = { connect: $("connect-steps").innerHTML, boot: $("boot-steps").innerHTML };

function renderHelp() {
  const d = helpDevice();
  const steps = (list: string[] | undefined, fallback: string) => list?.length ? list.map((s) => `<li>${esc(s)}</li>`).join("") : fallback;
  $("connect-steps").innerHTML = steps(d?.connect, defaults.connect);
  $("boot-steps").innerHTML = steps(d?.bootMode, defaults.boot);
  $("connect-notes").replaceChildren(...(d?.notes ?? []).map((n) => el("p", {}, n)));
  $("erase-hint").textContent = d?.keeps
    ? `Off: the unit keeps ${d.keeps}. On: it comes back on factory defaults. Use this to recover a unit whose settings or update state you do not trust.`
    : "Off: only the parts being written are erased, so settings stored on the board survive. On: the whole flash is erased first, as from the factory.";
}

function portFilters(): SerialPortFilter[] {
  const vids = new Set([...SERIAL_VIDS, ...bundle.flatMap((p) => (p.device.usb ?? []).map((u) => u.vendorId))]);
  return [...vids].map((usbVendorId) => ({ usbVendorId }));
}

$("connect").addEventListener("click", async () => {
  if (busy) return;
  let port: SerialPort;
  try {
    const any = ($("any-port") as HTMLInputElement).checked;
    port = await navigator.serial.requestPort(any ? {} : { filters: portFilters() });
  } catch {
    return; // chooser dismissed
  }
  await closeConsole();
  busy = true;
  refresh();
  status("Connecting…");
  try {
    session = await Session.open(port, log);
    unit = await session.describe(helpDevice()?.tableOffset);
    adoptRunningDevice();
    status(unit.chip ? "Connected." : `Connected, but this is an ${unit.chipName}, which this page does not flash.`, unit.chip ? "ok" : "err");
  } catch (e) {
    session = null;
    unit = null;
    status(`Could not talk to the board: ${message(e)}. See “No port listed” above.`, "err");
  }
  busy = false;
  renderDevice();
  void buildPlan();
});

$("disconnect").addEventListener("click", async () => {
  await session?.close();
  session = null;
  unit = null;
  renderDevice();
  status("");
  void buildPlan();
});

/** A unit running one of our devices' firmware picks that device. */
function adoptRunningDevice() {
  const project = unit?.running?.app?.project;
  if (!project || mode !== "release") return;
  const match = bundle.find((p) => p.device.projects.includes(project));
  if (match && match.device.id !== deviceId) selectDevice(match.device.id);
}

function renderDevice() {
  const t = $<HTMLTableElement>("device");
  t.replaceChildren();
  t.hidden = !unit;
  $("connect").hidden = !!unit;
  $("disconnect").hidden = !unit;
  if (!unit) return;
  const row = (k: string, v: Node | string) => t.append(el("tr", {}, el("th", {}, k), el("td", {}, v)));
  const want = plan && !("error" in plan) ? plan.want : null;
  const chipOk = !!unit.chip && (!want?.chip || want.chip.name === unit.chip.name);
  row("Chip", el("span", { className: chipOk ? "good" : "bad" }, unit.chipName));
  row("MAC", unit.mac);
  const flashOk = !want?.minFlash || unit.flashBytes >= want.minFlash;
  row("Flash", el("span", { className: flashOk ? "" : "bad" }, unit.flashLabel + (flashOk ? "" : ` (${want!.device?.name ?? "this firmware"} needs ${want!.minFlash! / 1048576}MB)`)));
  row("Partitions", unit.table ? unit.table.map((p) => p.label).join(", ") : "none (blank, or a layout this page cannot read)");
  const r = unit.running;
  row("Boots", !r ? "unknown" : r.app ? `${r.app.project} ${r.app.version} from ${r.partition}, built ${r.app.date}` : `${r.partition}, which holds no app image`);
}

// ---------------------------------------------------------------- our firmware

for (const [id, m] of [["tab-release", "release"], ["tab-file", "file"]] as const) {
  $(id).addEventListener("click", () => {
    mode = m;
    $("tab-release").setAttribute("aria-selected", String(m === "release"));
    $("tab-file").setAttribute("aria-selected", String(m === "file"));
    $("pane-release").hidden = m !== "release";
    $("pane-file").hidden = m !== "file";
    renderHelp();
    void buildPlan();
  });
}

async function loadBundle() {
  try {
    const index = (await (await fetch("/firmware/index.json", { cache: "no-cache" })).json()) as BundleIndex;
    const pkgs = await Promise.all(index.devices.map(async (id) => {
      const json = await (await fetch(`/firmware/${id}/manifest.json`, { cache: "no-cache" })).json();
      const { pkg, errors } = readPackage(json, []);
      if (!pkg || errors.length) throw new Error(`${id}: ${errors[0]}`);
      return pkg;
    }));
    bundle = pkgs;
  } catch (e) {
    $("device-meta").textContent = `The bundled firmware could not be loaded (${message(e)}). Your own file still works.`;
    return;
  }
  try {
    downloadsIndex = await (await fetch("/downloads/index.json", { cache: "no-cache" })).json();
  } catch {
    downloadsIndex = {};
  }
  if (!currentDevice()) deviceId = null;
  $("devices").replaceChildren(...bundle.map((p) => {
    const input = el("input", { type: "radio", name: "device", value: p.device.id, checked: p.device.id === deviceId });
    input.addEventListener("change", () => selectDevice(p.device.id));
    return el("label", { className: "card" }, input,
      el("span", {}, el("b", {}, p.device.name), el("span", { className: "chip" }, p.device.chip)),
      el("p", {}, p.device.status ?? ""));
  }));
  renderDownloads();
  if (deviceId) selectDevice(deviceId);
  else $("device-meta").textContent = "Pick the hardware you are flashing. Connecting a board that already runs our firmware picks it for you.";
}

function selectDevice(id: string) {
  deviceId = id;
  const pkg = currentDevice();
  for (const i of document.querySelectorAll<HTMLInputElement>("input[name=device]")) i.checked = i.value === id;
  if (!pkg) return;
  $("device-meta").replaceChildren(
    `${pkg.device.chip}, ${pkg.device.flashSize / 1048576} MB flash.`,
    ...(pkg.device.page ? [" ", el("a", { href: pkg.device.page, target: "_blank", rel: "noopener" }, `About the ${pkg.device.name}`)] : []),
  );
  $("release-box").hidden = false;
  fillReleases($<HTMLSelectElement>("release"), pkg.releases);
  renderVariants();
  renderHelp();
}

function fillReleases(sel: HTMLSelectElement, releases: Release[]) {
  sel.replaceChildren(...releases.map((r, i) =>
    el("option", { value: r.id }, `${r.id} · ${r.date}${r.tag ? ` · ${r.tag}` : ""}${i === 0 ? " (latest)" : ""}`)));
}
$("release").addEventListener("change", () => renderVariants());

function variantCards(box: HTMLElement, release: Release, keep: string | undefined, onPick: (v: Variant) => void): Variant {
  const chosen = release.variants.find((v) => v.id === keep) ?? release.variants.find((v) => v.recommended) ?? release.variants[0];
  box.replaceChildren(...release.variants.map((v) => {
    const input = el("input", { type: "radio", name: box.id, value: v.id, checked: v === chosen });
    input.addEventListener("change", () => onPick(v));
    return el("label", { className: "card" }, input,
      el("span", {}, el("b", {}, v.name), ...(v.recommended ? [el("span", { className: "rec" }, "recommended")] : [])),
      el("p", {}, v.summary));
  }));
  return chosen;
}

function renderVariants() {
  const pkg = currentDevice();
  if (!pkg) return;
  const release = pkg.releases.find((r) => r.id === $<HTMLSelectElement>("release").value) ?? pkg.releases[0];
  $("release-meta").textContent = `Built from ${pkg.device.name} ${release.commit.slice(0, 7)} with ESP-IDF ${release.variants[0].app.idfVersion}.` +
    (release.notes ? ` ${release.notes}` : "");
  const keep = pick?.release.id === release.id ? pick.variant.id : undefined;
  const v = variantCards($("variants"), release, keep, (nv) => { pick = { release, variant: nv }; void buildPlan(); });
  pick = { release, variant: v };
  $("release-downloads").replaceChildren(...downloadLinks(pkg.device, release));
  void buildPlan();
}

const fetched = new Map<string, Uint8Array>();

async function fetchPart(device: string, p: Part): Promise<Uint8Array> {
  const url = `/firmware/${device}/${p.path}`;
  const hit = fetched.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${p.path}: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if ((await sha256hex(data)) !== p.sha256) throw new Error(`${p.path} does not match its checksum`);
  fetched.set(url, data);
  return data;
}

// ---------------------------------------------------------------- downloads

function downloadLinks(d: DeviceDef, r: Release): (Node | string)[] {
  const files = [{ label: "release zip", name: zipName(d, r) }, ...r.variants.map((v) => ({ label: `${v.name} .bin`, name: mergedName(d, r, v) }))];
  const out: (Node | string)[] = ["Download: "];
  files.forEach((f, i) => {
    if (i) out.push(" · ");
    out.push(...fileLinks(d, r, f.name, f.label));
  });
  return out;
}

function fileLinks(d: DeviceDef, r: Release, name: string, label: string): (Node | string)[] {
  const gh = githubAsset(d, r, name);
  const local = `/downloads/${d.id}/${name}`;
  const a = (href: string, text: string) => el("a", { href, download: name }, text);
  return gh ? [a(gh, label), " (", a(local, "mirror"), ")"] : [a(local, label)];
}

function renderDownloads() {
  const box = $("downloads");
  box.replaceChildren(...bundle.map((p) => {
    const d = p.device;
    const t = el("table", { className: "parts" },
      el("thead", {}, el("tr", {}, el("th", {}, "Release"), el("th", {}, "File"), el("th", {}, "Size"), el("th", {}, "SHA-256"))));
    const body = el("tbody");
    for (const r of p.releases) {
      const known = downloadsIndex[d.id]?.[r.id] ?? [];
      const names = [zipName(d, r), ...r.variants.map((v) => mergedName(d, r, v))];
      names.forEach((name, i) => {
        const info = known.find((k) => k.name === name);
        const label = i === 0 ? "release zip" : `${r.variants[i - 1].name}, whole flash`;
        body.append(el("tr", {},
          el("td", {}, i === 0 ? `${r.id}${r.tag ? ` (${r.tag})` : ""} · ${r.date}` : ""),
          el("td", {}, ...fileLinks(d, r, name, label)),
          el("td", { className: "mono" }, info ? kb(info.size) : ""),
          el("td", { className: "mono sha" }, info?.sha256 ?? "")));
      });
    }
    t.append(body);
    return el("div", { className: "dl-device" },
      el("h3", {}, d.name, " ", el("span", { className: "chip" }, d.chip)),
      ...(d.repo ? [el("p", { className: "hint" }, "Every release is also on ", el("a", { href: `https://github.com/${d.repo}/releases` }, `${d.repo} on GitHub`), ".")] : []),
      t);
  }));
}

// ---------------------------------------------------------------- your own file

$("files").addEventListener("change", async () => {
  const files = [...($<HTMLInputElement>("files").files ?? [])];
  opened = null;
  filePick = null;
  loose = [];
  $("file-release").hidden = true;
  const bins: { name: string; data: Uint8Array }[] = [];
  try {
    for (const f of files) {
      const data = new Uint8Array(await f.arrayBuffer());
      if (isZip(data)) {
        if (files.length > 1) throw new Error("choose a release zip on its own");
        opened = await openPackageZip(data, bundle.map((p) => p.device));
      } else bins.push({ name: f.name, data });
    }
  } catch (e) {
    plan = { error: `${message(e)}.` };
    renderLoose();
    renderPlan();
    refresh();
    return;
  }
  if (opened) showOpened();
  loose = placeFiles(bins, unit?.table ?? null);
  renderLoose();
  renderHelp();
  void buildPlan();
});

function showOpened() {
  if (!opened) return;
  const d = opened.pkg.device;
  $("file-release").hidden = false;
  $("file-package").textContent = `A ${d.name} firmware package (${d.chip}). Every part matched its checksum.`;
  const sel = $<HTMLSelectElement>("file-release-select");
  fillReleases(sel, opened.pkg.releases);
  const render = () => {
    const r = opened!.pkg.releases.find((x) => x.id === sel.value) ?? opened!.pkg.releases[0];
    const v = variantCards($("file-variants"), r, filePick?.release.id === r.id ? filePick.variant.id : undefined,
      (nv) => { filePick = { release: r, variant: nv }; void buildPlan(); });
    filePick = { release: r, variant: v };
    void buildPlan();
  };
  sel.onchange = render;
  render();
}

function renderLoose() {
  const t = $<HTMLTableElement>("loose");
  const body = t.tBodies[0];
  body.replaceChildren();
  t.hidden = loose.length === 0;
  for (const f of loose) {
    const input = el("input", { type: "text", className: "offset mono", value: f.typed, placeholder: f.placed !== null ? hex(f.placed) : "offset?", spellcheck: false });
    input.addEventListener("input", () => { f.typed = input.value; void buildPlan(); });
    body.append(el("tr", {}, el("td", {}, f.name), el("td", {}, describeImage(f.info)), el("td", {}, input)));
  }
}

/** The chip a set of files was built for, from the first image that says. */
function chipOf(writes: PlannedWrite[]): Chip | null {
  for (const c of components(writes)) {
    if (c.info.kind === "app" || c.info.kind === "bootloader") return chipByImageId(c.info.chipId) ?? null;
  }
  return null;
}

function wantFor(d: DeviceDef, v: Variant): Want {
  return { device: d, chip: deviceChip(d), projects: d.projects, minFlash: d.flashSize, tableOffset: d.tableOffset, after: v.after };
}

// ---------------------------------------------------------------- the plan

let planSeq = 0;
async function buildPlan() {
  const seq = ++planSeq;
  let next: typeof plan = null;
  try {
    if (mode === "release") {
      const pkg = currentDevice();
      if (pkg && pick) {
        const writes = await Promise.all(pick.variant.parts.map(async (p) => ({ name: p.name, offset: p.offset, data: await fetchPart(pkg.device.id, p) })));
        next = { writes, notes: ["Every part matched its published SHA-256 checksum."], want: wantFor(pkg.device, pick.variant) };
      }
    } else if (opened && filePick) {
      const files = opened.files;
      next = { writes: variantWrites(filePick.variant, (p) => files.get(p)!), notes: ["Every part matched the checksum in its manifest."], want: wantFor(opened.pkg.device, filePick.variant) };
    } else if (loose.length) {
      const own = loose.find((f) => f.info.kind === "partition-table");
      const table = own && own.info.kind === "partition-table" ? own.info.partitions : unit?.table ?? null;
      const { writes, unplaced, badTyping } = looseWrites(loose, table);
      if (badTyping.length) next = { error: `${badTyping.join(", ")}: type the offset as 0x…, as 128K or 1M, or as a partition's name.` };
      else if (unplaced.length) {
        next = { error: `${unplaced.join(", ")}: the page cannot tell where ${unplaced.length > 1 ? "these go" : "this goes"}${unit ? "" : " until a board is connected and its partition table read"}. Type an offset.` };
      } else {
        const { writes: all, added } = withOtadataReset(writes, { unitTable: unit?.table ?? null });
        next = {
          writes: all,
          notes: added ? ["A blank otadata is added so the board boots the app you just wrote, not whatever it last updated to over the air."] : [],
          want: { device: null, chip: chipOf(all) },
        };
      }
    }
  } catch (e) {
    next = { error: message(e) };
  }
  if (seq !== planSeq) return; // a newer choice won
  plan = next;
  renderPlan();
  renderDevice();
  refresh();
}

function context(): PlanContext | null {
  if (!plan || "error" in plan || !unit?.chip) return null;
  return {
    chip: unit.chip,
    flashBytes: unit.flashBytes,
    projects: plan.want.projects,
    unitTable: unit.table,
    tableOffset: plan.want.tableOffset,
  };
}

function problems(): string[] {
  if (!plan || "error" in plan || !unit) return [];
  const w = plan.want;
  const p = unitProblems(unit, { chip: w.chip?.name, minFlash: w.minFlash, name: w.device?.name });
  const c = context();
  return [...p, ...(c ? checkPlan(plan.writes, c) : [])];
}

/** Writing over firmware other than this device's (or, for your own file, other than the file's own) needs a tick. */
function replaceText(): string | null {
  if (!unit?.running?.app || !plan || "error" in plan) return null;
  const running = unit.running.app;
  const apps = components(plan.writes).flatMap((c) => (c.info.kind === "app" ? [c.info.app] : []));
  if (!apps.length) return null;
  const ours = plan.want.projects ?? apps.map((a) => a.project);
  if (ours.includes(running.project)) return null;
  return `This board runs ${running.project} ${running.version}. Replace it with ${apps[0].project} ${apps[0].version}.`;
}

function renderPlan() {
  const t = $<HTMLTableElement>("plan");
  const body = t.tBodies[0];
  body.replaceChildren();
  const notes = $("plan-notes");
  notes.textContent = "";
  notes.className = "hint";
  const replace = replaceText();
  $("replace-box").hidden = !replace;
  $("replace-text").textContent = replace ?? "";
  if (!replace) $<HTMLInputElement>("replace").checked = false;
  if (!plan) { t.hidden = true; return; }
  if ("error" in plan) {
    t.hidden = true;
    notes.textContent = plan.error;
    notes.className = "hint status err";
    return;
  }
  t.hidden = false;
  for (const c of components(plan.writes).sort((a, b) => a.offset - b.offset)) {
    body.append(el("tr", {},
      el("td", {}, c.name),
      el("td", { className: "mono" }, hex(c.offset)),
      el("td", { className: "mono" }, kb(c.data.length)),
      el("td", {}, c.info.kind === "unknown" && c.raw ? "raw data, at the offset you typed" : describeImage(c.info))));
  }
  const refused = problems();
  const c = context();
  const extra = c ? planNotes(plan.writes, c) : [];
  notes.textContent = refused.length ? `Will not write this: ${refused.join("; ")}.`
    : [...plan.notes, ...extra, ...(unit ? [] : ["Connect a board, and this is checked against it before Flash is enabled."])].join(" ");
  if (refused.length) notes.className = "hint status err";
}

$("replace").addEventListener("change", () => refresh());

// ---------------------------------------------------------------- flash

function refresh() {
  const why = !hasSerial ? "Needs a browser with Web Serial."
    : !session || !unit ? "Connect a board first."
    : !plan ? "Choose firmware."
    : "error" in plan ? "The firmware choice has a problem."
    : problems()[0] ?? (replaceText() && !$<HTMLInputElement>("replace").checked ? "Tick the box to replace the firmware it runs." : "");
  const b = $<HTMLButtonElement>("flash");
  b.disabled = busy || why !== "";
  $("flash-why").textContent = busy ? "" : why;
  $<HTMLButtonElement>("connect").disabled = busy || !hasSerial;
  $<HTMLButtonElement>("disconnect").disabled = busy;
}

$("flash").addEventListener("click", async () => {
  if (!session || !plan || "error" in plan || busy) return;
  const eraseAll = $<HTMLInputElement>("erase-all").checked;
  const want = plan.want;
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
      projects: want.projects,
      expectChip: want.chip?.name,
      minFlash: want.minFlash,
      tableOffset: want.tableOffset,
      onProgress: (done, total) => {
        fill.style.width = `${(100 * done) / total}%`;
        status(`Writing… ${kb(done)} of ${kb(total)}`);
      },
    });
    fill.style.width = "100%";
    status("Written and verified. Rebooting the board…");
    await session.resetAndClose();
    session = null;
    unit = null;
    renderDevice();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status(`Done in ${secs} s. The board has rebooted into the new firmware. ` + (want.after ?? "Open the console below to watch it boot."), "ok");
  } catch (e) {
    const steps = helpDevice()?.bootMode?.join(" ") ?? "Hold BOOT, tap EN or RESET, release BOOT,";
    status(`Flashing stopped: ${message(e)}. The board is recoverable: ${steps.replace(/\.?\s*$/, "")}, then connect and flash again.`, "err");
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
    const vids = new Set(portFilters().map((f) => f.usbVendorId));
    const known = (await navigator.serial.getPorts()).find((p) => vids.has(p.getInfo().usbVendorId));
    const any = ($("any-port") as HTMLInputElement).checked;
    consolePort = known ?? await navigator.serial.requestPort(any ? {} : { filters: portFilters() });
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
    term.textContent += "\n[port went away: the board reset, or its firmware took the USB port for something else]\n";
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

renderHelp();
void loadBundle();
refresh();
