import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { Queue } from './queue.js';
import { createApp } from './app.js';
import { spawn } from 'node:child_process';
import { RemoteSnapshot } from './remote-snapshot.js';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const hosted = process.env.WA_HOSTED === '1' || !!process.env.RENDER;
const dataDir = path.resolve(process.env.WA_DATA_DIR || (hosted ? path.join(os.tmpdir(), 'wa-auto-cloud') : path.join(projectDir, 'data')));
fs.mkdirSync(dataDir, { recursive: true });

const snapshot = hosted ? new RemoteSnapshot() : null;
if (hosted) {
  if (!snapshot.configured) {
    console.error('WA.Auto cloud requer SUPABASE_URL, SUPABASE_ANON_KEY (ou SUPABASE_PUBLISHABLE_KEY) e WA_DB_SECRET.');
    process.exit(1);
  }
  try {
    const restored = await snapshot.restore(dataDir);
    console.log(restored ? 'Estado remoto restaurado.' : 'Primeira inicialização cloud: nenhum snapshot anterior.');
  } catch (error) {
    console.error('Não foi possível restaurar o estado remoto:', error.message);
    process.exit(1);
  }
}

const lockPath = path.join(dataDir, 'app.lock');
function acquireLock() {
  try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    let alive = true;
    try { if (!pid) alive = false; else process.kill(pid, 0); } catch (checkError) { if (checkError.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('O WA.Auto já está aberto nesta instância.');
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  }
}
try { acquireLock(); } catch (error) { console.error(error.message); process.exit(1); }
process.on('exit', () => { try { if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath); } catch {} });

const store = new Store(path.join(dataDir, 'wa-auto.sqlite'));
const persist = () => snapshot?.schedule(dataDir, store);
const transport = new WhatsApp(dataDir, { onPersistentChange: persist });
transport.on('state', state => console.log(`WhatsApp state: ${state.status}`));
const queue = new Queue(store, transport);
queue.on('change', persist);
queue.on('queueError', persist);

const app = createApp({ store, transport, queue, onMutation: persist });
const port = Number(process.env.PORT || 3210);
const host = hosted ? '0.0.0.0' : '127.0.0.1';
const server = app.listen(port, host, () => {
  const url = hosted ? `http://0.0.0.0:${port}` : `http://127.0.0.1:${port}`;
  console.log(`\nWA.Auto está pronto: ${url}\nModo: ${hosted ? 'cloud' : 'desenvolvimento local'}\n`);
  if (!hosted && process.env.WA_OPEN_BROWSER === '1' && process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  }
  const autoConnect = hosted || process.env.WA_AUTO_CONNECT === '1';
  if (autoConnect) setImmediate(() => void transport.connect().catch(error => console.error('Falha ao iniciar conexão do WhatsApp:', error.message)));
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso.` : error.message);
  process.exit(1);
});

const cloudPersistTimer = hosted ? setInterval(() => {
  void snapshot.save(dataDir, store).catch(error => console.error('Falha no snapshot periódico:', error.message));
}, 15000) : null;
cloudPersistTimer?.unref?.();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(cloudPersistTimer);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  await queue.close();
  if (hosted) await snapshot.close(dataDir, store).catch(error => console.error('Falha ao salvar estado final:', error.message));
  if (!queue.busy) store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
