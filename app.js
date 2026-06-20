const BAUD_TOUCH = 1200;
const BAUD_BOOTLOADER = 57600;
const PAGE_SIZE = 128;

let normalPort = null;
let bootPort = null;
let firmware = null;

const logEl = document.getElementById("log");
const supportStatus = document.getElementById("supportStatus");
const firmwareInfo = document.getElementById("firmwareInfo");
const connectBtn = document.getElementById("connectBtn");
const bootBtn = document.getElementById("bootBtn");
const bootSelectBtn = document.getElementById("bootSelectBtn");
const progressText = document.getElementById("progressText");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(percent, text) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${p}%`;
  progressPercent.textContent = `${p}%`;
  progressText.textContent = text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseHex(hexText) {
  const memory = new Map();
  let upper = 0;
  let maxAddress = 0;

  for (const rawLine of hexText.trim().split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error("Invalid HEX file");

    const len = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = [];

    let sum = len + (addr >> 8) + (addr & 0xff) + type;
    for (let i = 0; i < len; i++) {
      const value = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
      data.push(value);
      sum += value;
    }

    const checksum = parseInt(line.slice(9 + len * 2, 11 + len * 2), 16);
    if (((sum + checksum) & 0xff) !== 0) {
      throw new Error(`HEX checksum failed: ${line}`);
    }

    if (type === 0x00) {
      const base = upper + addr;
      for (let i = 0; i < data.length; i++) {
        memory.set(base + i, data[i]);
        maxAddress = Math.max(maxAddress, base + i);
      }
    }
    else if (type === 0x01) {
      break;
    }
    else if (type === 0x04) {
      upper = ((data[0] << 8) | data[1]) << 16;
    }
  }

  const size = Math.ceil((maxAddress + 1) / PAGE_SIZE) * PAGE_SIZE;
  const bytes = new Uint8Array(size);
  bytes.fill(0xff);
  for (const [address, value] of memory.entries()) bytes[address] = value;

  return { bytes, size, maxAddress: maxAddress + 1 };
}

async function loadFirmware() {
  const response = await fetch("./firmware.hex", { cache: "no-store" });
  if (!response.ok) throw new Error("Cannot load firmware.hex");
  const text = await response.text();
  firmware = parseHex(text);
  firmwareInfo.textContent = `${firmware.maxAddress} bytes`;
  log(`Firmware loaded: ${firmware.maxAddress} bytes`);
}

async function safelyClosePort(port) {
  if (!port) return;
  try { await port.close(); } catch {}
}

async function touch1200(port) {
  log("Opening selected COM at 1200 baud...");
  await port.open({ baudRate: BAUD_TOUCH });
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch {}
  await sleep(250);
  await safelyClosePort(port);
  log("Reset command sent. Wait until Windows reconnects the bootloader COM.");
}

class Avr109 {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.readBuffer = [];
  }

  async open() {
    await this.port.open({ baudRate: BAUD_BOOTLOADER, bufferSize: 4096 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
  }

  async close() {
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    await safelyClosePort(this.port);
  }

  async write(bytes) {
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  async readByte(timeoutMs = 2000) {
    if (this.readBuffer.length > 0) return this.readBuffer.shift();

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Bootloader read timeout")), timeoutMs);
    });

    const result = await Promise.race([this.reader.read(), timeout]);
    if (result.done || !result.value || result.value.length === 0) {
      throw new Error("Bootloader COM disconnected");
    }

    const bytes = Array.from(result.value);
    const first = bytes.shift();
    this.readBuffer.push(...bytes);
    return first;
  }

  async expectOk(context) {
    const got = await this.readByte();
    if (got !== 0x0d) {
      throw new Error(`${context} failed, response 0x${got.toString(16)}`);
    }
  }

  async getStringCommand(command, length) {
    await this.write([command.charCodeAt(0)]);
    const out = [];
    for (let i = 0; i < length; i++) out.push(await this.readByte());
    return String.fromCharCode(...out);
  }

  async setAddress(byteAddress) {
    const wordAddress = byteAddress >> 1;
    await this.write([
      "A".charCodeAt(0),
      (wordAddress >> 8) & 0xff,
      wordAddress & 0xff
    ]);
    await this.expectOk("Set address");
  }

  async writePage(byteAddress, page) {
    await this.setAddress(byteAddress);

    const packet = new Uint8Array(4 + page.length);
    packet[0] = "B".charCodeAt(0);
    packet[1] = (page.length >> 8) & 0xff;
    packet[2] = page.length & 0xff;
    packet[3] = "F".charCodeAt(0);
    packet.set(page, 4);

    await this.write(packet);
    await this.expectOk(`Write page 0x${byteAddress.toString(16)}`);
  }

  async leaveBootloader() {
    try {
      await this.write(["E".charCodeAt(0)]);
      await this.readByte(500);
    } catch {}
  }
}

connectBtn.addEventListener("click", async () => {
  try {
    normalPort = await navigator.serial.requestPort({});
    bootBtn.disabled = false;
    log("Normal COM selected.");
  }
  catch (error) {
    log(`Port selection cancelled or failed: ${error.message}`);
  }
});

bootBtn.addEventListener("click", async () => {
  if (!normalPort) return;
  bootBtn.disabled = true;
  connectBtn.disabled = true;
  setProgress(0, "Entering bootloader");

  try {
    await touch1200(normalPort);
    normalPort = null;
    bootSelectBtn.disabled = false;
    setProgress(0, "Select bootloader COM");
    log("Now click step 3 and select the new bootloader COM port.");
  }
  catch (error) {
    log(`Bootloader reset failed: ${error.message}`);
    connectBtn.disabled = false;
    bootBtn.disabled = false;
  }
});

bootSelectBtn.addEventListener("click", async () => {
  try {
    bootPort = await navigator.serial.requestPort({});
    log("Bootloader COM selected. Flashing now...");
    await flashFirmware();
  }
  catch (error) {
    log(`Bootloader COM selection cancelled or failed: ${error.message}`);
  }
});

async function flashFirmware() {
  if (!bootPort || !firmware) return;

  bootSelectBtn.disabled = true;
  setProgress(0, "Opening bootloader");

  const avr = new Avr109(bootPort);

  try {
    await avr.open();

    try {
      const id = await avr.getStringCommand("S", 7);
      log(`Bootloader ID: ${id}`);
    } catch {
      log("Could not read bootloader ID. Continuing.");
    }

    const pages = firmware.size / PAGE_SIZE;
    for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
      const address = pageIndex * PAGE_SIZE;
      const page = firmware.bytes.slice(address, address + PAGE_SIZE);
      await avr.writePage(address, page);
      setProgress((pageIndex + 1) * 100 / pages, `Writing ${pageIndex + 1}/${pages}`);
    }

    await avr.leaveBootloader();
    setProgress(100, "Flash complete");
    log("Flash complete. Unplug and plug the USB cable again.");
  }
  catch (error) {
    setProgress(0, "Flash failed");
    log(`Flash failed: ${error.message}`);
    bootSelectBtn.disabled = false;
    log("If this says failed to open serial port, the bootloader timed out. Repeat step 1 to 3 faster.");
  }
  finally {
    try { await avr.close(); } catch {}
  }
}

(async function init() {
  if (!("serial" in navigator)) {
    supportStatus.textContent = "Web Serial not supported";
    supportStatus.className = "status bad";
    connectBtn.disabled = true;
    bootBtn.disabled = true;
    bootSelectBtn.disabled = true;
    log("Use desktop Chrome or Edge.");
    return;
  }

  supportStatus.textContent = "Web Serial supported";
  supportStatus.className = "status ok";

  try {
    await loadFirmware();
  }
  catch (error) {
    firmwareInfo.textContent = "Load failed";
    connectBtn.disabled = true;
    log(`Firmware load failed: ${error.message}`);
  }
})();
