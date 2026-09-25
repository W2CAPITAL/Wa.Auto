import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import makeWASocket, { Browsers, useMultiFileAuthState } from '@whiskeysockets/baileys';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-baileys-live-'));
let socket;
try {
  const { state } = await useMultiFileAuthState(dir);
  socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('WA.Auto CI'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  const reached = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Baileys não chegou ao QR em 60 segundos.')), 60000);
    socket.ev.on('connection.update', update => {
      if (update.qr || update.connection === 'open') {
        clearTimeout(timer);
        resolve(update.qr ? 'qr' : 'open');
      }
      if (update.connection === 'close' && !update.qr) {
        const status = update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode;
        if (status === 401) {
          clearTimeout(timer);
          reject(new Error('WhatsApp encerrou a sessão de teste antes do QR.'));
        }
      }
    });
  });
  console.log(`Baileys cloud real alcançou estado: ${reached}`);
} finally {
  try { socket?.end?.(new Error('CI concluído')); } catch {}
  try { socket?.ws?.close?.(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
