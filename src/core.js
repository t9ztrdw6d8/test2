// Front System Diagnostic – core logic (protocol, links, diagnostics).
// Port of the Android app (V6), which itself follows advanced.cpp of V1–V5.
"use strict";

const now = () => performance.now();

/* ---------- register layout (documentation/registers.xlsx) ---------- */
// index 0 = bit 1 (value 128) … index 7 = bit 8 (value 1); null = unused bit
const RM = {
  pollOrder: ["DR0", "DR1", "DAW10", "DEW0", "DEW1", "DEW2", "DEW11", "DAW0", "DAW1"],
  analog: new Set(["DR0", "DR1"]),
  bits: {
    DAW0: [null, "BOOST", null, "NORM", "OPENING", "CLOSING", "ENALED", "PUSH"],
    DAW1: [null, null, "DEFSEAL", null, "DEFLATE", "DIAPH", "INFSEAL", "INFLATE"],
    DAW10: ["BSTLAMP", "NCF", "NFD", "NPD", "POK", "NFLD", "NSF", "FDL"],
    DEW0: ["FCE", null, "CLOSED", "LFTOUT", "ACTBST", "KEYOPEN", "RHTIN", "LFTIN"],
    DEW1: [null, "LFTWHT", "LOWTEMP", "KEYCLOSE", "ACTNORM", "KEYACT", null, "RHTOUT"],
    DEW2: [null, "RHTRED", null, "TOPWHT", "LFTRED", "RHTWHT", null, null],
    DEW11: [null, null, "NTC", null, "PREPARE", "NTNC", "NFOT", "NBOT"],
  },
  isSet: (value, index) => ((value >> (7 - index)) & 1) === 1,
  decode(register, value) {
    const out = {};
    (RM.bits[register] || []).forEach((name, i) => { if (name) out[name] = RM.isSet(value, i); });
    return out;
  },
  encode(register, signals) {
    let value = 0;
    (RM.bits[register] || []).forEach((name, i) => { if (name && signals[name]) value |= 1 << (7 - i); });
    return value;
  },
};

/* ---------- frames: the PLC ends every answer with DC1 (0x11) ---------- */
class FrameParser {
  constructor() { this.buf = ""; }
  reset() { this.buf = ""; }
  feed(bytes) {
    for (let i = 0; i < bytes.length; i++) this.buf += String.fromCharCode(bytes[i]);
    const frames = [];
    let end;
    while ((end = this.buf.indexOf("\x11")) >= 0) {
      const raw = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 1);
      const frame = FrameParser.parse(raw);
      if (frame) frames.push(frame);
    }
    if (this.buf.length > 4096) this.buf = "";
    return frames;
  }
  static parse(raw) {
    const text = raw.trim();
    if (text.replace(/[> ]/g, "") === "") return null;
    const id = text.indexOf("FPC-");
    if (id >= 0) return { type: "id", name: text.slice(id).split(/\r?\n/)[0].trim() };
    if (text.includes("SYNTAX ERROR")) return { type: "syntax" };
    const m = text.match(/([A-Z]{2,4}\d{1,2})\s*=\s*(\d{1,3})/);
    if (m && +m[2] <= 255) return { type: "reg", name: m[1], value: +m[2] };
    return { type: "unknown", raw: text };
  }
}

/* ---------- protocol: init, polling, manual commands, timeouts ----------
   Event driven: the next command goes out the moment an answer arrives. */
class PlcConnection {
  constructor(handlers) {
    this.h = handlers; // onRegister(name, value), onStatus(status), onTerminal({out, text})
    this.status = { state: "off", linkName: "", plcName: "", problem: null, detail: "", rt: 0, fps: 0 };
    this.session = 0;
    this.link = null;
    this.closing = Promise.resolve();
    this.parser = new FrameParser();
    this.timer = null;
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.h.onStatus({ ...this.status });
  }

  async connect(link, timeoutMs) {
    this.closeLink();
    const session = ++this.session;
    this.timeoutMs = timeoutMs;
    this.parser.reset();
    this.poll = 0;
    this.manual = [];
    this.waitingFor = null;
    this.outstanding = false;
    this.rts = [];
    this.rtCount = 0;
    this.frames = 0;
    this.setStatus({ state: "opening", linkName: link.name, plcName: "", problem: null, detail: "", rt: 0, fps: 0 });
    try {
      await this.closing;
      await link.open(
        (bytes) => { if (session === this.session) this.onBytes(bytes); },
        (message) => { if (session === this.session) this.lost("lost", message); },
      );
    } catch (e) {
      try { link.close(); } catch (_) { /* already closed */ }
      if (session === this.session) this.setStatus({ state: "off", problem: "open", detail: (e && e.message) || String(e) });
      return;
    }
    if (session !== this.session) { link.close(); return; }
    this.link = link;
    const t = now();
    this.lastRx = t;
    this.statsSince = t;
    this.setStatus({ state: "waiting" });
    this.sendInit();
    this.timer = setInterval(() => { if (session === this.session) this.tick(); }, 50);
  }

  disconnect() {
    this.closeLink();
    this.session++;
    this.setStatus({ state: "off", problem: null, detail: "", fps: 0 });
  }

  /** One command between the polling; the answer goes to the terminal. */
  send(command) {
    const cmd = command.trim().toUpperCase();
    if (!cmd) return;
    if (!this.link) { this.h.onTerminal({ out: false, text: "—" }); return; }
    this.manual.push(cmd);
    if (!this.outstanding) this.sendNext();
  }

  onBytes(bytes) {
    const t = now();
    this.lastRx = t;
    const frames = this.parser.feed(bytes);
    if (!frames.length) return;
    if (this.outstanding) this.recordRt(t - this.sentAt);
    frames.forEach((f) => this.handle(f));
    this.outstanding = false;
    this.sendNext();
  }

  handle(f) {
    switch (f.type) {
      case "id":
        if (this.status.plcName !== f.name) this.h.onTerminal({ out: false, text: f.name });
        this.setStatus({ state: "on", plcName: f.name, problem: null, detail: "" });
        break;
      case "reg":
        if (this.status.state !== "on") this.setStatus({ state: "on", problem: null, detail: "" });
        this.frames++;
        this.h.onRegister(f.name, f.value);
        if (this.waitingFor === f.name) {
          this.h.onTerminal({ out: false, text: `${f.name} = ${f.value}` });
          this.waitingFor = null;
        }
        break;
      case "syntax":
        this.h.onTerminal({ out: false, text: "E1: SYNTAX ERROR" + (this.waitingFor ? ` (${this.waitingFor})` : "") });
        this.waitingFor = null;
        break;
      default:
        this.h.onTerminal({ out: false, text: f.raw });
    }
  }

  sendNext() {
    if (!this.link) return;
    let cmd = this.manual.shift();
    if (cmd) {
      this.waitingFor = cmd;
      this.h.onTerminal({ out: true, text: cmd });
    } else {
      cmd = RM.pollOrder[this.poll];
      this.poll = (this.poll + 1) % RM.pollOrder.length;
    }
    this.write(cmd + "\r\n");
    this.outstanding = true;
    this.sentAt = now();
  }

  sendInit() {
    this.parser.reset();
    this.lastInit = now();
    this.write("\x14\r");
    this.outstanding = true;
    this.sentAt = this.lastInit;
  }

  tick() {
    if (!this.link) return;
    const t = now();
    const silent = t - this.lastRx;
    if (silent > this.timeoutMs) { this.lost("timeout", ""); return; }
    if (silent > 1000) {
      // PLC stopped answering: re-initialise every 500 ms (same as V1–V5)
      if (this.status.state === "on") this.setStatus({ state: "retry" });
      if (t - this.lastInit >= 500) this.sendInit();
      return;
    }
    if (this.status.state === "on" && this.outstanding && t - this.sentAt > 250) {
      // an answer got lost: carry on with the next register
      this.outstanding = false;
      this.sendNext();
    }
    if (t - this.statsSince >= 1000) {
      const fps = Math.round((this.frames * 1000) / (t - this.statsSince));
      this.frames = 0;
      this.statsSince = t;
      const n = Math.min(this.rtCount, 9);
      const rt = n ? Math.round(this.rts.slice(0, n).reduce((a, b) => a + b, 0) / n) : 0;
      this.setStatus({ fps, rt });
    }
  }

  recordRt(ms) {
    this.rts[this.rtCount % 9] = ms;
    this.rtCount++;
  }

  write(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
    const session = this.session;
    try {
      const p = this.link.write(bytes);
      if (p && p.catch) p.catch((e) => { if (session === this.session) this.lost("lost", (e && e.message) || String(e)); });
    } catch (e) {
      this.lost("lost", (e && e.message) || String(e));
    }
  }

  lost(problem, detail) {
    if (!this.link) return;
    this.closeLink();
    this.session++;
    this.setStatus({ state: "off", problem, detail, fps: 0 });
  }

  closeLink() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.link) {
      const link = this.link;
      this.closing = Promise.resolve().then(() => link.close()).catch(() => {});
    }
    this.link = null;
    this.outstanding = false;
    this.waitingFor = null;
  }
}

/* ---------- demo PLC: a simulated train for trying the app ----------
   36 s cycle: head of train (Pideal 50) → coupled (20) → end of train (20),
   with a failing left red lamp near the end (error 23). */
class DemoPlc {
  constructor() { this.name = "Demo PLC"; }
  open(onData) {
    this.onData = onData;
    this.start = now();
    this.lastP = this.start;
    this.pressure = 0;
    this.open_ = true;
    return Promise.resolve();
  }
  write(bytes) {
    if (!this.open_) throw new Error("closed");
    const cmd = String.fromCharCode(...bytes);
    setTimeout(() => this.answer(cmd), 12 + Math.random() * 6);
  }
  close() { this.open_ = false; }
  answer(cmd) {
    if (!this.open_) return;
    let text;
    if (cmd.includes("\x14")) text = "\r\nFPC-DEMO 96\r\n>";
    else {
      const reg = cmd.trim();
      const v = this.value(reg);
      text = v === null ? "\r\nE1: SYNTAX ERROR\r\n>" : `${reg}=${v}\r\n>`;
    }
    text += "\x11";
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    this.onData(out);
  }
  value(reg) {
    const t = now();
    const second = Math.floor((t - this.start) / 1000) % 36;
    const scenario = Math.floor(second / 12);
    const pideal = scenario === 0 ? 50 : 20;
    const step = Math.min(Math.abs(pideal - this.pressure), (8 * (t - this.lastP)) / 1000);
    this.lastP = t;
    this.pressure += this.pressure < pideal ? step : -step;
    const fault = scenario === 2 && second >= 29 && second <= 33;
    const s = {
      INFLATE: this.pressure < pideal - 1, DEFLATE: this.pressure > pideal + 1, FCE: true,
      ACTNORM: true, NORM: true, CLOSED: true, LFTIN: true, RHTIN: true, ENALED: true, POK: true,
      NFLD: !fault, NCF: true, NSF: true, NPD: true, NFD: true, FDL: true,
    };
    if (scenario === 0) Object.assign(s, { TOPWHT: true, LFTWHT: true, RHTWHT: true, NTC: true, NBOT: true });
    else if (scenario === 1) Object.assign(s, { NTNC: true, NFOT: true, NBOT: true });
    else Object.assign(s, { LFTRED: !fault, RHTRED: true, NTC: true, NFOT: true });
    if (reg === "DR0") return Math.floor(this.pressure);
    if (reg === "DR1") return pideal;
    if (RM.bits[reg]) return RM.encode(reg, s);
    return null;
  }
}

/* ---------- Web Serial (Chrome/Edge on a PC) ---------- */
class WebSerialLink {
  constructor(port) {
    this.port = port;
    const info = port.getInfo ? port.getInfo() : {};
    this.name = info.usbVendorId === 0x067b ? "Prolific PL2303" : "USB-serial";
  }
  async open(onData, onError) {
    await this.port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    this.closed = false;
    this.writer = this.port.writable.getWriter();
    this.loop(onData, onError);
  }
  async loop(onData, onError) {
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) onData(value);
        }
      } catch (e) {
        if (!this.closed) { onError((e && e.message) || String(e)); return; }
      } finally {
        try { this.reader.releaseLock(); } catch (_) { /* released */ }
      }
    }
  }
  write(bytes) { return this.writer.write(bytes); }
  async close() {
    this.closed = true;
    try { if (this.reader) await this.reader.cancel(); } catch (_) { /* gone */ }
    try { if (this.writer) this.writer.releaseLock(); } catch (_) { /* gone */ }
    try { await this.port.close(); } catch (_) { /* already closed */ }
  }
}

/* ---------- WebUSB driver for Prolific PL2303 cables (Chrome on Android) ----------
   Follows the Linux driver (drivers/usb/serial/pl2303.c): the chip type is detected from the
   USB descriptor and decides the init sequence. Covers the old HX/HXD/TA/TB chips and the newer
   "HXN" family (GC/GB/GT/GL/GE/GS/GR, and the PL2303RA in e.g. the ACT AC6002 USB-C cable). */
const PROLIFIC_VID = 0x067b;
const PL2303_HXN_PIDS = new Set([0x23a3, 0x23b3, 0x23c3, 0x23d3, 0x23e3, 0x23f3]);
const BAUD_RATE = 9600;
const hex4 = (n) => n.toString(16).padStart(4, "0").toUpperCase();

class Pl2303Link {
  constructor(device) {
    this.d = device;
    this.name = device.productName || "Prolific PL2303";
    /** What happened during open(), shown on the Registers page to help when a cable does not work. */
    this.info = {
      vidPid: `${hex4(device.vendorId)}:${hex4(device.productId)}`,
      product: device.productName || "",
      maker: device.manufacturerName || "",
      bcdUsb: hex4(Pl2303Link.bcd(device.usbVersionMajor, device.usbVersionMinor, device.usbVersionSubminor)),
      bcdDevice: hex4(Pl2303Link.bcd(device.deviceVersionMajor, device.deviceVersionMinor, device.deviceVersionSubminor)),
      type: "?", steps: [], rxBytes: 0, txBytes: 0,
    };
  }

  static bcd(major, minor, sub) { return (major << 8) | (minor << 4) | sub; }

  step(text) { this.info.steps.push(text); }

  // vendor requests: 0x01 on the older chips, 0x80 (write) / 0x81 (read) on HXN
  async vendorRead(value) {
    const r = await this.d.controlTransferIn(
      { requestType: "vendor", recipient: "device", request: this.hxn ? 0x81 : 0x01, value, index: 0 }, 1);
    if (r.status !== "ok" || !r.data || r.data.byteLength < 1) throw new Error(`vendor read ${hex4(value)} failed`);
    return r.data.getUint8(0);
  }
  async vendorWrite(value, index) {
    const r = await this.d.controlTransferOut(
      { requestType: "vendor", recipient: "device", request: this.hxn ? 0x80 : 0x01, value, index });
    if (r.status !== "ok") throw new Error(`vendor write ${hex4(value)} failed`);
  }
  async updateReg(reg, mask, val) {
    const cur = await this.vendorRead(this.hxn ? reg : reg | 0x80);
    await this.vendorWrite(reg, (cur & ~mask) | (val & mask));
  }

  /** Same probe as pl2303_supports_hx_status(): only the older chips answer this read. */
  async supportsHxStatus() {
    try {
      const r = await this.d.controlTransferIn(
        { requestType: "vendor", recipient: "device", request: 0x01, value: 0x8080, index: 0 }, 1);
      return r.status === "ok" && r.data && r.data.byteLength === 1;
    } catch (_) { return false; }
  }

  /** pl2303_detect_type(); bMaxPacketSize0 is not visible in WebUSB, the old PL2303H is assumed absent. */
  async detectType() {
    const d = this.d;
    if (d.deviceClass === 0x02) return "H";
    if (PL2303_HXN_PIDS.has(d.productId)) return "HXN";
    const bcdUsb = parseInt(this.info.bcdUsb, 16);
    const bcdDevice = parseInt(this.info.bcdDevice, 16);
    if (bcdUsb === 0x101 || bcdUsb === 0x110) return bcdDevice === 0x400 ? "HXD" : "HX";
    switch (bcdDevice) {
      case 0x300: return (await this.supportsHxStatus()) ? "TA" : "HXN";
      case 0x500: return (await this.supportsHxStatus()) ? "TB" : "HXN";
      case 0x100: case 0x105: case 0x305: case 0x400: case 0x405: case 0x505: case 0x600:
      case 0x605: case 0x700: case 0x705: case 0x905: case 0x1005:
        return "HXN";
    }
    // unknown revision: let the chip tell which request set it understands
    return (await this.supportsHxStatus()) ? "HX" : "HXN";
  }

  async open(onData, onError) {
    const d = this.d;
    await d.open();
    this.step("USB open");
    if (d.configuration === null) await d.selectConfiguration(1);
    const iface = d.configuration.interfaces[0];
    await d.claimInterface(iface.interfaceNumber);
    this.ifn = iface.interfaceNumber;
    this.step(`interface ${this.ifn} claimed`);
    const eps = iface.alternate.endpoints;
    const bulkIn = eps.find((e) => e.type === "bulk" && e.direction === "in");
    const bulkOut = eps.find((e) => e.type === "bulk" && e.direction === "out");
    if (!bulkIn || !bulkOut) throw new Error("no bulk endpoints: this is not a PL2303 serial cable");
    this.inEp = bulkIn.endpointNumber;
    this.outEp = bulkOut.endpointNumber;
    this.packet = bulkIn.packetSize || 64;

    const type = await this.detectType();
    this.info.type = type;
    this.hxn = type === "HXN";
    this.step(`chip type ${type}`);

    if (this.hxn) {
      // reset the up- and downstream data pipes
      await this.vendorWrite(0x07, 0x03);
    } else {
      // init sequence of the older chips ("black magic" in usb-serial-for-android); reads may fail
      const read = (v) => this.vendorRead(v).catch(() => 0);
      await read(0x8484); await this.vendorWrite(0x0404, 0);
      await read(0x8484); await read(0x8383);
      await read(0x8484); await this.vendorWrite(0x0404, 1);
      await read(0x8484); await read(0x8383);
      await this.vendorWrite(0, 1); await this.vendorWrite(1, 0);
      await this.vendorWrite(2, type === "H" ? 0x24 : 0x44);
      await this.vendorWrite(8, 0); await this.vendorWrite(9, 0);
    }
    this.step("init done");

    // SET_LINE_CODING: 9600 baud, 1 stop bit, no parity, 8 data bits
    const line = new Uint8Array([BAUD_RATE & 255, (BAUD_RATE >> 8) & 255, (BAUD_RATE >> 16) & 255, BAUD_RATE >>> 24, 0, 0, 8]);
    const lr = await d.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x20, value: 0, index: this.ifn }, line);
    if (lr.status !== "ok") throw new Error("setting 9600 8N1 failed");
    // SET_CONTROL_LINE_STATE: DTR + RTS
    await d.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 0x03, index: this.ifn });
    // no flow control
    try {
      if (this.hxn) await this.updateReg(0x0a, 0x1c, 0x1c);
      else await this.updateReg(0, 0xf0, 0);
    } catch (e) { this.step("flow control: " + e.message); }
    this.step(`line ${BAUD_RATE} 8N1, DTR+RTS`);

    this.closed = false;
    (async () => {
      while (!this.closed) {
        try {
          const r = await d.transferIn(this.inEp, this.packet);
          if (r.status === "stall") { await d.clearHalt("in", this.inEp); continue; }
          if (r.data && r.data.byteLength) {
            this.info.rxBytes += r.data.byteLength;
            onData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
          }
        } catch (e) {
          if (!this.closed) { this.step("read: " + ((e && e.message) || e)); onError((e && e.message) || String(e)); }
          return;
        }
      }
    })();
  }

  async write(bytes) {
    const r = await this.d.transferOut(this.outEp, bytes);
    if (r.status === "stall") { await this.d.clearHalt("out", this.outEp); throw new Error("write stalled"); }
    this.info.txBytes += r.bytesWritten || 0;
  }

  async close() {
    this.closed = true;
    try { await this.d.releaseInterface(this.ifn); } catch (_) { /* gone */ }
    try { await this.d.close(); } catch (_) { /* gone */ }
  }
}

/* ---------- diagnostics: the rules of V1–V5 (advanced.cpp calc… functions) ----------
   An error is valid once present for errorDelayMs; status lamp errors (80–84) get 6 s extra. */
const ERROR_CODES = [11, 12, 13, 21, 22, 23, 24, 25, 26, 31, 41, 51, 61, 62, 71, 72, 73, 74, 81, 82, 83, 84];

class Diagnostics {
  constructor(clock = now, wallClock = Date.now) {
    this.clock = clock;
    this.wallClock = wallClock;
    this.errorDelayMs = 1500;
    this.pressureTimeoutS = 105;
    this.history = [];
    this.nextId = 1;
    this.reset();
  }
  reset() {
    this.values = {};
    this.signals = {};
    this.leftBolt = "unknown";
    this.rightBolt = "unknown";
    this.outOfRangeSince = -1;
    this.presentSince = new Map();
    this.clearActive();
  }
  clearActive() {
    const codes = [...(this.active ? this.active.keys() : [])];
    codes.forEach((c) => this.closeEvent(c));
    this.active = new Map();
    this.presentSince = new Map();
    return codes;
  }
  clearHistory() { this.history = this.history.filter((e) => e.clearedAt === null); }
  /** Newest first. */
  events() { return this.history.slice().reverse(); }
  update(register, value) {
    if (this.values[register] === value) return false;
    this.values[register] = value;
    Object.assign(this.signals, RM.decode(register, value));
    return true;
  }
  evaluate() {
    const t = this.clock();
    const s = (n) => this.signals[n] === true;
    const pfront = this.values.DR0 ?? 0;
    const pideal = this.values.DR1 ?? 0;
    const complete = RM.pollOrder.every((r) => r in this.values);

    const actbst = s("ACTBST"), actnorm = s("ACTNORM");
    const heater = actnorm && !actbst ? "normal" : actbst && !actnorm ? "boost" : "off";

    const ntnc = s("NTNC"), ntc = s("NTC"), nfot = s("NFOT"), nbot = s("NBOT");
    const coupling = ntnc && !ntc && nfot && nbot ? "coupled"
      : !ntnc && ntc && nfot && !nbot ? "end"
      : !ntnc && ntc && !nfot && nbot ? "front" : "none";
    const expectedPideal = coupling === "front" ? 50 : coupling === "none" ? null : 20;

    const top = s("TOPWHT"), lw = s("LFTWHT"), rw = s("RHTWHT"), lr = s("LFTRED"), rr = s("RHTRED");
    const lights = !top && !lw && !rw && !lr && !rr ? "off"
      : !top && lw && rw && !lr && !rr ? "twoWhite"
      : top && lw && rw && !lr && !rr ? "threeWhite"
      : !top && !lw && !rw && lr && rr ? "twoRed" : "invalid";

    const keyact = s("KEYACT"), keyopen = s("KEYOPEN"), keyclose = s("KEYCLOSE");
    const key = keyact && keyopen && !keyclose ? "opening" : keyact && !keyopen && keyclose ? "closing" : "neutral";

    const lftin = s("LFTIN"), lftout = s("LFTOUT"), rhtin = s("RHTIN"), rhtout = s("RHTOUT");
    if (lftin && !lftout) this.leftBolt = "in"; else if (!lftin && lftout) this.leftBolt = "out";
    if (rhtin && !rhtout) this.rightBolt = "in"; else if (!rhtin && rhtout) this.rightBolt = "out";
    const opening = s("OPENING"), closing = s("CLOSING"), push = s("PUSH");
    const door = opening && !closing && !push ? "closed"
      : !opening && !closing && push ? "pushed"
      : !opening && closing && !push ? "closed"
      : this.leftBolt === "out" && this.rightBolt === "out" ? "unlocked"
      : this.leftBolt === "in" && this.rightBolt === "in" ? "closed" : "half";

    const inRange = !(pfront <= pideal - 5 || pfront >= pideal + 12);
    if (inRange) this.outOfRangeSince = -1; else if (this.outOfRangeSince < 0) this.outOfRangeSince = t;

    const state = {
      registers: { ...this.values }, signals: { ...this.signals }, pfront, pideal, pressureInRange: inRange,
      coupling, expectedPideal, heater, lights, key, door, leftBolt: this.leftBolt, rightBolt: this.rightBolt, complete,
    };
    if (!complete) return { state, active: [...this.active.values()], raised: [], cleared: [] };

    const found = new Map();
    const b = (v) => (v ? 1 : 0);
    if (expectedPideal !== null && pideal !== expectedPideal) found.set(11, [pideal, expectedPideal]);
    if (this.outOfRangeSince >= 0 && t - this.outOfRangeSince >= this.pressureTimeoutS * 1000) found.set(12, [pfront, pideal, this.pressureTimeoutS]);
    if (s("INFLATE") && s("DEFLATE")) found.set(13, []);
    if (lights === "invalid") {
      const codes = [];
      if (!lw && rw) codes.push(21);
      if (lw && !rw) codes.push(22);
      if (!lr && rr) codes.push(23);
      if (lr && !rr) codes.push(24);
      if (top && !lw && !rw) codes.push(25);
      // V1–V5 reported "Error 20" (only a group title) when no single rule matched; that is 26 here
      if (codes.length === 1) found.set(codes[0], []);
      else found.set(26, [b(lw), b(rw), b(top), b(lr), b(rr)]);
    }
    if (actbst && actnorm) found.set(31, []);
    if (ntnc && ntc) found.set(41, []);
    if (s("INFSEAL") && s("DEFSEAL")) found.set(51, []);
    if (!keyact && (keyopen || keyclose)) found.set(61, []);
    if (keyopen && keyclose) found.set(62, []);
    const bolts = [b(lftin), b(lftout), b(rhtin), b(rhtout)];
    if (lftin && lftout) found.set(rhtin ? 71 : 72, bolts);
    if (rhtin && rhtout) found.set(lftin ? 73 : 74, bolts);
    const fdlExp = (lftin && rhtin) || coupling === "coupled";
    if (fdlExp !== s("FDL")) found.set(81, [b(s("FDL")), b(fdlExp)]);
    const nsfExp = !(lftin && lftout) && !(rhtin && rhtout);
    if (nsfExp !== s("NSF")) found.set(82, [b(s("NSF")), b(nsfExp)]);
    const nfldExp = lights !== "invalid";
    if (nfldExp !== s("NFLD")) found.set(83, [b(s("NFLD")), b(nfldExp)]);
    const ncfExp = coupling !== "none";
    if (ncfExp !== s("NCF")) found.set(84, [b(s("NCF")), b(ncfExp)]);

    const raised = [], cleared = [];
    for (const [code, args] of found) {
      if (!this.presentSince.has(code)) this.presentSince.set(code, t);
      const existing = this.active.get(code);
      if (existing) {
        if (existing.args.join() !== args.join()) this.active.set(code, { ...existing, args });
      } else if (t - this.presentSince.get(code) >= this.delayFor(code)) {
        const error = { code, args, since: this.wallClock() };
        this.active.set(code, error);
        raised.push(error);
        this.history.push({ id: this.nextId++, code, args, raisedAt: error.since, clearedAt: null });
        if (this.history.length > 300) this.history.shift();
      }
    }
    for (const code of [...this.presentSince.keys()]) if (!found.has(code)) this.presentSince.delete(code);
    for (const code of [...this.active.keys()]) {
      if (!found.has(code)) {
        this.active.delete(code);
        this.closeEvent(code);
        cleared.push(code);
      }
    }
    return { state, active: [...this.active.values()], raised, cleared };
  }
  delayFor(code) {
    if (code === 12) return 0; // has its own timeout (pressureTimeoutS)
    return code >= 80 ? this.errorDelayMs + 6000 : this.errorDelayMs;
  }
  closeEvent(code) {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].code === code && this.history[i].clearedAt === null) {
        this.history[i] = { ...this.history[i], clearedAt: this.wallClock() };
        return;
      }
    }
  }
}

/* ---------- self tests (same cases as the Android unit tests) ---------- */
function fsdSelfTest() {
  const results = [];
  const check = (name, ok) => results.push((ok ? "PASS " : "FAIL ") + name);
  const head = () => ({
    TOPWHT: true, LFTWHT: true, RHTWHT: true, NTC: true, NBOT: true, ACTNORM: true, NORM: true, CLOSED: true,
    LFTIN: true, RHTIN: true, ENALED: true, POK: true, FCE: true, NFLD: true, NCF: true, NSF: true, NPD: true, NFD: true, FDL: true,
  });
  const make = () => {
    const c = { t: 0 };
    const d = new Diagnostics(() => c.t, () => 1e12 + c.t);
    d.feed = (sig, pf = 50, pi = 50) => { d.update("DR0", pf); d.update("DR1", pi); Object.keys(RM.bits).forEach((r) => d.update(r, RM.encode(r, sig))); };
    return [d, c];
  };
  const codes = (d) => d.evaluate().active.map((e) => e.code).join();

  const p = new FrameParser();
  const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const f = p.feed(enc("DR0=45\r\n>\x11DEW0=37\r\n>\x11"));
  check("parser: two answers in one chunk", f.length === 2 && f[1].name === "DEW0" && f[1].value === 37);
  check("parser: identity", p.feed(enc("\r\nFPC-DEMO 96\r\n>\x11"))[0].name === "FPC-DEMO 96");
  const dew0 = RM.decode("DEW0", 37);
  check("bits: DEW0=37 is CLOSED, KEYOPEN, LFTIN", dew0.CLOSED && dew0.KEYOPEN && dew0.LFTIN && !dew0.FCE && RM.encode("DEW0", dew0) === 37);

  let [d, c] = make();
  d.feed(head());
  let r = d.evaluate();
  c.t += 20000;
  check("healthy head of train", r.state.coupling === "front" && r.state.lights === "threeWhite" && r.state.door === "closed" && codes(d) === "");

  [d, c] = make();
  d.feed(head()); d.evaluate();
  d.feed({ ...head(), LFTWHT: false, NFLD: false });
  const before = codes(d);
  c.t += 1600;
  const after = codes(d);
  d.feed(head());
  r = d.evaluate();
  check("lamp fault: error 21 after 1.5 s and cleared again", before === "" && after === "21" && r.cleared.join() === "21" && d.events()[0].clearedAt !== null);

  [d, c] = make();
  d.feed({ ...head(), NCF: false }); d.evaluate();
  c.t += 2000; const early = codes(d);
  c.t += 6000;
  check("status lamp errors wait 6 s longer", early === "" && codes(d) === "84");

  [d, c] = make();
  d.feed(head(), 30, 30); d.evaluate(); c.t += 2000;
  check("wrong Pideal is error 11", d.evaluate().active.find((e) => e.code === 11).args.join() === "30,50");

  [d, c] = make();
  d.pressureTimeoutS = 10;
  d.feed(head(), 20, 50); d.evaluate(); c.t += 9000; const e1 = codes(d); c.t += 1500;
  check("pressure error only after the timeout", !e1.includes("12") && codes(d).includes("12"));

  [d, c] = make();
  d.feed({ ...head(), LFTOUT: true, NSF: false }); d.evaluate(); c.t += 2000;
  check("bolt in and out at once is 71", codes(d) === "71");

  [d, c] = make();
  d.update("DEW2", 0); d.evaluate(); c.t += 20000;
  check("nothing before all registers arrived", codes(d) === "");
  return results;
}
