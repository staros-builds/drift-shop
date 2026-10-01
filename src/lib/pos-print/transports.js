/* Printer transports for Drift POS.
 *
 * Four ways to reach a receipt printer, widest compatibility first:
 *
 *  browser  — renders the receipt as HTML in a hidden iframe and calls
 *             window.print(). Works with ANY printer the OS knows about,
 *             on any setup. No drawer kick possible through this path.
 *  webusb   — raw ESC/POS straight to a USB thermal printer via WebUSB
 *             (Chrome/Edge desktop + Android). No drivers needed.
 *  serial   — raw ESC/POS over the Web Serial API (RS-232 / USB-serial).
 *  qz       — QZ Tray bridge (free download from qz.io) over a local
 *             WebSocket. Covers network printers, driver-bound USB
 *             printers, and serial printers QZ can see.
 *
 * Cash drawers plug into the printer's DK port, so "open drawer" just
 * sends the ESC/POS kick pulse through whichever raw transport is active.
 */

import { drawerKickBytes } from './escpos.js';

const QZ_CDN = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.6/qz-tray.min.js';
const QZ_CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2/qz-tray.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-drift-qz="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.driftQz = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  // btoa is ASCII-safe here: ESC/POS bytes are transliterated to < 256.
  return btoa(bin);
}

/* ------------------------------------------------------------------ */
/* Session device handles (reused so the user only picks once)         */
/* ------------------------------------------------------------------ */

let usbDevice = null;
let serialPort = null;

export function forgetDevices() {
  usbDevice = null;
  serialPort = null;
}

/* ------------------------------------------------------------------ */
/* browser — universal fallback                                        */
/* ------------------------------------------------------------------ */

export const browserTransport = {
  id: 'browser',
  label: 'System printer (print dialog)',
  hint: 'Uses the normal print dialog — works with any printer installed on this device.',
  isSupported() {
    return typeof window !== 'undefined' && typeof window.print === 'function';
  },
  /** html: full receipt HTML document string. */
  async printHtml(html) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(iframe);
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
      await new Promise((r) => setTimeout(r, 350));
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 2000);
    }
  },
  async printBytes() {
    throw new Error('This connection prints through the system dialog — use “Test print” to preview the receipt layout.');
  },
  async openDrawer() {
    throw new Error('The cash drawer plugs into the receipt printer — connect the printer directly (USB / serial / QZ Tray) to kick the drawer.');
  },
};

/* ------------------------------------------------------------------ */
/* webusb — direct USB ESC/POS                                         */
/* ------------------------------------------------------------------ */

async function ensureUsbDevice() {
  if (usbDevice) return usbDevice;
  if (!('usb' in navigator)) {
    throw new Error('WebUSB is not available in this browser. Use Chrome or Edge on desktop/Android.');
  }
  // Empty filters: let the user pick their printer (many thermal printers
  // use vendor-specific USB classes, so classCode filters would hide them).
  const device = await navigator.usb.requestDevice({ filters: [] });
  await device.open();
  if (device.configuration === undefined) await device.selectConfiguration(1);
  let claimed = false;
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      const outEp = alt.endpoints.find((e) => e.direction === 'out' && (e.type === 'bulk' || e.type === 'interrupt'));
      if (outEp) {
        try {
          await device.claimInterface(iface.interfaceNumber);
          device.__driftOutEp = outEp.endpointNumber;
          device.__driftIface = iface.interfaceNumber;
          claimed = true;
        } catch { /* try next interface */ }
      }
      if (claimed) break;
    }
    if (claimed) break;
  }
  if (!claimed) {
    try { await device.close(); } catch { /* ignore */ }
    throw new Error('Could not claim a USB output endpoint on that device. It may need its manufacturer driver — try the system-printer or QZ Tray connection instead.');
  }
  usbDevice = device;
  return device;
}

async function usbWrite(bytes) {
  const device = await ensureUsbDevice();
  try {
    await device.transferOut(device.__driftOutEp, bytes);
  } catch (err) {
    usbDevice = null;
    try { await device.close(); } catch { /* ignore */ }
    throw new Error(`USB write failed: ${err?.message || err}`);
  }
}

export const webusbTransport = {
  id: 'webusb',
  label: 'USB receipt printer (direct)',
  hint: 'Talks ESC/POS straight to the printer over USB — no drivers. Chrome/Edge required.',
  isSupported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  },
  async printBytes(bytes) { await usbWrite(bytes); },
  async printHtml() {
    throw new Error('Direct USB prints raw ESC/POS only.');
  },
  async openDrawer(pin = 0) { await usbWrite(drawerKickBytes(pin)); },
};

/* ------------------------------------------------------------------ */
/* serial — Web Serial ESC/POS                                         */
/* ------------------------------------------------------------------ */

async function ensureSerialPort(baudRate = 9600) {
  if (serialPort) return serialPort;
  if (!('serial' in navigator)) {
    throw new Error('Web Serial is not available in this browser. Use Chrome or Edge on desktop.');
  }
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  serialPort = port;
  return port;
}

async function serialWrite(bytes, baudRate) {
  const port = await ensureSerialPort(baudRate);
  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
  } catch (err) {
    throw new Error(`Serial write failed: ${err?.message || err}`);
  } finally {
    writer.releaseLock();
  }
}

export const serialTransport = {
  id: 'serial',
  label: 'Serial receipt printer',
  hint: 'RS-232 / USB-serial printers via the Web Serial API. Chrome/Edge desktop required.',
  isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  },
  async printBytes(bytes, opts = {}) { await serialWrite(bytes, opts.baudRate); },
  async printHtml() {
    throw new Error('Direct serial prints raw ESC/POS only.');
  },
  async openDrawer(pin = 0, opts = {}) { await serialWrite(drawerKickBytes(pin), opts.baudRate); },
};

/* ------------------------------------------------------------------ */
/* qz — QZ Tray bridge                                                 */
/* ------------------------------------------------------------------ */

async function ensureQz() {
  if (typeof window === 'undefined') throw new Error('QZ Tray needs a browser.');
  if (!window.qz) {
    try {
      await loadScript(QZ_CDN);
    } catch {
      await loadScript(QZ_CDN_FALLBACK);
    }
  }
  const qz = window.qz;
  if (!qz) {
    throw new Error('Could not load the QZ Tray client library. Check your connection and try again.');
  }
  // Unsigned requests: QZ Tray blocks these by default. The user enables
  // them once in QZ Tray → Advanced → "Allow unsigned requests".
  if (qz.security && typeof qz.security.setCertificatePromise !== 'function') { /* noop */ }
  if (!qz.websocket.isActive()) {
    try {
      await qz.websocket.connect();
    } catch (err) {
      throw new Error(
        'Could not reach QZ Tray on this computer. Install it from qz.io/download, make sure it is running, ' +
        `then try again. (${err?.message || err})`
      );
    }
  }
  return qz;
}

export const qzTransport = {
  id: 'qz',
  label: 'QZ Tray (network / driver printers)',
  hint: 'Free bridge app on this computer — reaches network printers and any printer QZ Tray can see.',
  isSupported() { return typeof window !== 'undefined'; },
  async listPrinters() {
    const qz = await ensureQz();
    return qz.printers.find();
  },
  async printBytes(bytes, opts = {}) {
    const qz = await ensureQz();
    const printer = opts.qzPrinterName || undefined;
    const config = qz.configs.create(printer, { copies: opts.copies || 1 });
    const data = [{ type: 'raw', format: 'base64', flavor: 'base64', data: bytesToBase64(bytes) }];
    try {
      await qz.print(config, data);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/unsigned/i.test(msg)) {
        throw new Error('QZ Tray blocked the request: open QZ Tray → Advanced and enable “Allow unsigned requests”, then try again.');
      }
      throw new Error(`QZ Tray print failed: ${msg}`);
    }
  },
  async printHtml() {
    throw new Error('QZ Tray prints raw ESC/POS only in this mode.');
  },
  async openDrawer(pin = 0, opts = {}) {
    await this.printBytes(drawerKickBytes(pin), opts);
  },
};

export const TRANSPORTS = {
  browser: browserTransport,
  webusb: webusbTransport,
  serial: serialTransport,
  qz: qzTransport,
};

export function getTransport(id) {
  return TRANSPORTS[id] || browserTransport;
}
