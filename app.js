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
    if (line[0] !== ":") throw new Error("\u56fa\u4ef6 HEX \u683c\u5f0f\u9519\u8bef");

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
      throw new Error(`HEX \u6821\u9a8c\u5931\u8d25: ${line}`);
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
  if (!response.ok) throw new Error("\u65e0\u6cd5\u52a0\u8f7d firmware.hex");
  const text = await response.text();
  firmware = parseHex(text);
  firmwareInfo.textContent = `${firmware.maxAddress} bytes`;
  log(`\u56fa\u4ef6\u5df2\u52a0\u8f7d: ${firmware.maxAddress} bytes`);
}

async function safelyClosePort(port) {
  if (!port) return;
  try { await port.close(); } catch {}
}

async function touch1200(port) {
  log("\u6b63\u5728\u4ee5 1200 baud \u6253\u5f00\u5f53\u524d\u4e32\u53e3...");
  await port.open({ baudRate: BAUD_TOUCH });
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch {}
  await sleep(250);
  await safelyClosePort(port);
  log("\u5df2\u53d1\u9001\u91cd\u542f\u547d\u4ee4\u3002\u8bf7\u7b49\u5f85 Windows \u8bc6\u522b\u65b0\u7684\u5237\u673a\u4e32\u53e3\u3002");
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
      setTimeout(() => reject(new Error("\u8bfb\u53d6\u5237\u673a\u6a21\u5f0f\u8d85\u65f6")), timeoutMs);
    });

    const result = await Promise.race([this.reader.read(), timeout]);
    if (result.done || !result.value || result.value.length === 0) {
      throw new Error("\u5237\u673a\u4e32\u53e3\u5df2\u65ad\u5f00");
    }

    const bytes = Array.from(result.value);
    const first = bytes.shift();
    this.readBuffer.push(...bytes);
    return first;
  }

  async expectOk(context) {
    const got = await this.readByte();
    if (got !== 0x0d) {
      throw new Error(`${context} \u5931\u8d25, \u8fd4\u56de 0x${got.toString(16)}`);
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
    await this.expectOk("\u8bbe\u7f6e\u5199\u5165\u5730\u5740");
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
    await this.expectOk(`\u5199\u5165\u9875 0x${byteAddress.toString(16)}`);
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
    log("\u5df2\u9009\u62e9\u8bbe\u5907\u5f53\u524d\u4e32\u53e3\u3002");
  }
  catch (error) {
    log(`\u4e32\u53e3\u9009\u62e9\u5df2\u53d6\u6d88\u6216\u5931\u8d25: ${error.message}`);
  }
});

bootBtn.addEventListener("click", async () => {
  if (!normalPort) return;
  bootBtn.disabled = true;
  connectBtn.disabled = true;
  setProgress(0, "\u6b63\u5728\u8fdb\u5165\u5237\u673a\u6a21\u5f0f");

  try {
    await touch1200(normalPort);
    normalPort = null;
    bootSelectBtn.disabled = false;
    setProgress(0, "\u8bf7\u9009\u62e9\u5237\u673a\u4e32\u53e3");
    log("\u73b0\u5728\u70b9\u51fb\u7b2c 3 \u6b65\uff0c\u9009\u62e9\u65b0\u51fa\u73b0\u7684\u5237\u673a\u4e32\u53e3\u3002");
  }
  catch (error) {
    log(`\u8fdb\u5165\u5237\u673a\u6a21\u5f0f\u5931\u8d25: ${error.message}`);
    connectBtn.disabled = false;
    bootBtn.disabled = false;
  }
});

bootSelectBtn.addEventListener("click", async () => {
  try {
    bootPort = await navigator.serial.requestPort({});
    log("\u5df2\u9009\u62e9\u5237\u673a\u4e32\u53e3\uff0c\u6b63\u5728\u5199\u5165\u56fa\u4ef6...");
    await flashFirmware();
  }
  catch (error) {
    log(`\u5237\u673a\u4e32\u53e3\u9009\u62e9\u5df2\u53d6\u6d88\u6216\u5931\u8d25: ${error.message}`);
  }
});

async function flashFirmware() {
  if (!bootPort || !firmware) return;

  bootSelectBtn.disabled = true;
  setProgress(0, "\u6b63\u5728\u6253\u5f00\u5237\u673a\u4e32\u53e3");

  const avr = new Avr109(bootPort);

  try {
    await avr.open();

    try {
      const id = await avr.getStringCommand("S", 7);
      log(`Bootloader ID: ${id}`);
    } catch {
      log("\u672a\u8bfb\u53d6\u5230 Bootloader ID\uff0c\u7ee7\u7eed\u5199\u5165\u3002");
    }

    const pages = firmware.size / PAGE_SIZE;
    for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
      const address = pageIndex * PAGE_SIZE;
      const page = firmware.bytes.slice(address, address + PAGE_SIZE);
      await avr.writePage(address, page);
      setProgress((pageIndex + 1) * 100 / pages, `\u5199\u5165\u4e2d ${pageIndex + 1}/${pages}`);
    }

    await avr.leaveBootloader();
    setProgress(100, "\u5237\u673a\u5b8c\u6210");
    log("\u5237\u673a\u5b8c\u6210\u3002\u8bf7\u91cd\u65b0\u63d2\u62d4 USB\u3002");
  }
  catch (error) {
    setProgress(0, "\u5237\u673a\u5931\u8d25");
    log(`\u5237\u673a\u5931\u8d25: ${error.message}`);
    bootSelectBtn.disabled = false;
    log("\u5982\u679c\u63d0\u793a\u6253\u5f00\u4e32\u53e3\u5931\u8d25\uff0c\u901a\u5e38\u662f Bootloader \u8d85\u65f6\u3002\u8bf7\u66f4\u5feb\u5730\u91cd\u590d\u7b2c 1 \u5230\u7b2c 3 \u6b65\u3002");
  }
  finally {
    try { await avr.close(); } catch {}
  }
}

(async function init() {
  if (!("serial" in navigator)) {
    supportStatus.textContent = "\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 Web Serial";
    supportStatus.className = "status bad";
    connectBtn.disabled = true;
    bootBtn.disabled = true;
    bootSelectBtn.disabled = true;
    log("\u8bf7\u4f7f\u7528\u7535\u8111\u7248 Chrome \u6216 Edge \u6d4f\u89c8\u5668\u3002");
    return;
  }

  supportStatus.textContent = "\u6d4f\u89c8\u5668\u652f\u6301 Web Serial";
  supportStatus.className = "status ok";

  try {
    await loadFirmware();
  }
  catch (error) {
    firmwareInfo.textContent = "\u52a0\u8f7d\u5931\u8d25";
    connectBtn.disabled = true;
    log(`\u56fa\u4ef6\u52a0\u8f7d\u5931\u8d25: ${error.message}`);
  }
})();
