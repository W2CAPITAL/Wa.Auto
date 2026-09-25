import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { Queue } from './queue.js';
import { createApp } from './app.js';
import { spawn } from 'node:child_process';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.resolve(process.env.WA_DATA_DIR || path.join(projectDir, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const lockPath = path.join(dataDir, 'app.lock');
function acquireLock() {
  try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    let alive = true;
    try { if (!pid) alive = false; else process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('O WA.Auto já está aberto. Acesse http://127.0.0.1:3210 no navegador.');
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  }
}
try { acquireLock(); } catch (error) { console.error(error.message); process.exit(1); }
process.on('exit', () => { try { if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath); } catch {} });
const store = new Store(path.join(dataDir, 'wa-auto.sqlite'));
const transport = new WhatsApp(dataDir);
const queue = new Queue(store, transport);
const app = createApp({ store, transport, queue });
const port = Number(process.env.PORT || 3210);
const server = app.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nWA.Auto está pronto: ${url}\nMantenha esta janela aberta durante os envios.\n`);
  if (process.env.WA_OPEN_BROWSER === '1' && process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Feche a outra instância ou altere PORT.` : error.message); process.exit(1); });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  await queue.close();
  // Leave any send still in flight recorded as sending; next launch will mark it uncertain.
  if (!queue.busy) store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
