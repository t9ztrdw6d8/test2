// Tests the WebUSB PL2303 driver against a simulated PL2303 chip with a demo PLC behind it.
// Run: npm test
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, performance, setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array, DataView, Promise, Date, Math };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "core.js"), "utf8") +
  "\nthis.Pl2303Link = Pl2303Link; this.PlcConnection = PlcConnection; this.DemoPlc = DemoPlc; this.Diagnostics = Diagnostics;", ctx);
const { Pl2303Link, PlcConnection, DemoPlc, Diagnostics } = ctx;

/**
 * Simulated PL2303. Older chips (hx = true) answer vendor request 0x01 incl. the 0x8080 status read;
 * HXN chips only accept 0x80/0x81 and stall on 0x01. Bytes written to the bulk OUT endpoint go to a
 * demo PLC whose answers come back on the bulk IN endpoint.
 */
function fakeDevice({ pid = 0x2303, bcdUsb = [2, 0, 0], bcdDevice = [3, 0, 5], hx = false }) {
  const log = [];
  const plc = new DemoPlc();
  const rx = [];
  let waiting = null;
  let lineSet = null;
  plc.open((bytes) => { rx.push(bytes); if (waiting) { const w = waiting; waiting = null; w(); } });
  const ok = (data) => ({ status: "ok", data: data ? new DataView(data.buffer) : undefined, bytesWritten: 0 });
  const stall = { status: "stall" };
  const dev = {
    vendorId: 0x067b, productId: pid, productName: "USB-Serial Controller", manufacturerName: "Prolific Technology Inc.",
    deviceClass: 0, usbVersionMajor: bcdUsb[0], usbVersionMinor: bcdUsb[1], usbVersionSubminor: bcdUsb[2],
    deviceVersionMajor: bcdDevice[0], deviceVersionMinor: bcdDevice[1], deviceVersionSubminor: bcdDevice[2],
    configuration: null,
    log,
    get line() { return lineSet; },
    async open() { log.push("open"); },
    async close() { log.push("close"); },
    async selectConfiguration() {
      this.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
        { endpointNumber: 1, direction: "in", type: "interrupt", packetSize: 10 },
        { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 64 },
        { endpointNumber: 3, direction: "in", type: "bulk", packetSize: 64 },
      ] } }] };
    },
    async claimInterface(n) { log.push("claim " + n); },
    async releaseInterface() {},
    async clearHalt() {},
    async controlTransferIn(setup, length) {
      log.push(`in ${setup.requestType} ${setup.request.toString(16)} ${setup.value.toString(16)}`);
      if (setup.requestType !== "vendor") return stall;
      if (hx && setup.request === 0x01) return ok(new Uint8Array(length));
      if (!hx && setup.request === 0x81) return ok(new Uint8Array([0x00]));
      return stall;
    },
    async controlTransferOut(setup, data) {
      log.push(`out ${setup.requestType} ${setup.request.toString(16)} ${setup.value.toString(16)} ${setup.index.toString(16)}`);
      if (setup.requestType === "vendor") return (hx ? setup.request === 0x01 : setup.request === 0x80) ? ok() : stall;
      if (setup.request === 0x20) lineSet = Array.from(data);
      return ok();
    },
    async transferOut(ep, bytes) { plc.write(bytes); return { status: "ok", bytesWritten: bytes.length }; },
    async transferIn() {
      if (!rx.length) await new Promise((r) => { waiting = r; });
      const b = rx.shift();
      return { status: "ok", data: new DataView(b.buffer, b.byteOffset, b.byteLength) };
    },
  };
  return dev;
}

const results = [];
const check = (name, okay, extra = "") => { results.push(okay); console.log((okay ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : "")); };

async function runCable(name, opts, expectType) {
  const dev = fakeDevice(opts);
  const link = new Pl2303Link(dev);
  const seen = {};
  let status = {};
  const conn = new PlcConnection({ onRegister: (n, v) => { seen[n] = v; }, onStatus: (s) => { status = s; }, onTerminal() {} });
  await conn.connect(link, 3000);
  const t0 = performance.now();
  while (Object.keys(seen).length < 9 && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 1100)); // one statistics period
  conn.disconnect();

  check(`${name}: chip type ${expectType}`, link.info.type === expectType, "detected " + link.info.type);
  const vendor = dev.log.filter((l) => l.includes(" vendor "));
  const badRequests = vendor.filter((l) => {
    const req = l.split(" ")[2];
    return expectType === "HXN" ? !(["80", "81"].includes(req) || l.includes(" 8080")) : req !== "1";
  });
  check(`${name}: only the right vendor requests`, badRequests.length === 0, badRequests.slice(0, 2).join(", "));
  check(`${name}: line coding 9600 8N1`, JSON.stringify(dev.line) === JSON.stringify([0x80, 0x25, 0, 0, 0, 0, 8]), JSON.stringify(dev.line));
  check(`${name}: DTR+RTS set`, dev.log.includes("out class 22 3 0"));
  check(`${name}: PLC identified and all 9 registers read`, status.plcName === "FPC-DEMO 96" && Object.keys(seen).length === 9, `${Object.keys(seen).length} registers, ${status.fps} answers/s`);
  return link;
}

(async () => {
  // ACT AC6002 / PL2303RA and other new chips report USB 2.0 and a 0x305-style revision
  await runCable("PL2303RA/GT (HXN, bcdDevice 0305)", { pid: 0x2303, bcdDevice: [3, 0, 5] }, "HXN");
  await runCable("PL2303GC (HXN product id 23A3)", { pid: 0x23a3, bcdDevice: [1, 0, 0] }, "HXN");
  await runCable("PL2303TA (bcdDevice 0300, answers HX status)", { bcdDevice: [3, 0, 0], hx: true }, "TA");
  await runCable("PL2303GT without HX status (bcdDevice 0300)", { bcdDevice: [3, 0, 0], hx: false }, "HXN");
  await runCable("PL2303HX (USB 1.1)", { bcdUsb: [1, 1, 0], bcdDevice: [3, 0, 0], hx: true }, "HX");
  await runCable("unknown revision, old chip", { bcdDevice: [8, 0, 0], hx: true }, "HX");

  // the explanation card on the Registers page shows the start-up steps
  const info = (await runCable("info for diagnosis card", { bcdDevice: [3, 0, 5] }, "HXN")).info;
  check("diagnosis info filled", info.vidPid === "067B:2303" && info.bcdDevice === "0305" && info.steps.length >= 5 && info.rxBytes > 0 && info.txBytes > 0,
    `${info.vidPid} rev ${info.bcdDevice}, ${info.steps.length} steps, ${info.rxBytes}/${info.txBytes} bytes`);

  // the error rules still pass (same self-test as in the browser)
  const self = vm.runInContext("fsdSelfTest()", ctx);
  check("diagnostics self-test", self.every((r) => r.startsWith("PASS")), self.filter((r) => !r.startsWith("PASS")).join("; "));

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
