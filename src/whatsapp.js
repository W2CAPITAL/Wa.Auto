import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { fold } from './phone.js';
import { requireValue } from './errors.js';

const timeout = (promise, milliseconds) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('O WhatsApp demorou demais para responder.')), milliseconds); })]).finally(() => clearTimeout(timer));
};
export class WhatsApp extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.state = { status: 'disconnected', qr: null, account: null, message: 'Conecte seu WhatsApp para começar.' };
    this.generation = 0;
    this.connecting = false;
  }
  snapshot() { return this.state; }
  isReady() { return this.state.status === 'ready'; }
  update(state) { this.state = { ...this.state, ...state }; this.emit('state', this.state); }
  async connect() {
    if (this.connecting || ['connecting', 'qr', 'authenticated', 'ready'].includes(this.state.status)) return;
    this.connecting = true;
    try {
      await this.close();
      const generation = ++this.generation;
      const { default: pkg } = await import('whatsapp-web.js');
      const { Client, LocalAuth } = pkg;
      const chromeCandidates = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH];
      if (process.platform === 'win32') {
        for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
          chromeCandidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        }
      }
      const executablePath = chromeCandidates.find(candidate => candidate && fs.existsSync(candidate));
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: 'wa-auto', dataPath: path.join(this.dataDir, 'session') }),
        webVersionCache: { type: 'local', path: path.join(this.dataDir, 'web-cache') },
        deviceName: 'WA.Auto',
        authTimeoutMs: 120000,
        qrMaxRetries: 8,
        puppeteer: { headless: true, ...(executablePath ? { executablePath } : {}), args: ['--disable-dev-shm-usage'] },
      });
      this.client = client;
      const current = () => this.client === client && generation === this.generation;
      this.update({ status: 'connecting', qr: null, account: null, message: 'Abrindo a conexão com o WhatsApp…' });
      client.on('qr', code => {
        void QRCode.toDataURL(code, { margin: 2, width: 280 }).then(qr => {
          if (current()) this.update({ status: 'qr', qr, message: 'Escaneie com WhatsApp → Aparelhos conectados → Conectar aparelho.' });
        }).catch(() => { if (current()) this.update({ status: 'error', qr: null, message: 'Não foi possível gerar o QR Code. Tente conectar novamente.' }); });
      });
      client.on('authenticated', () => { if (current()) this.update({ status: 'authenticated', qr: null, message: 'Conta vinculada. Carregando suas conversas…' }); });
      client.on('ready', () => {
        if (current()) this.update({ status: 'ready', qr: null, account: { name: client.info?.pushname || 'WhatsApp', phone: client.info?.wid?.user || '' }, message: 'WhatsApp conectado. Você já pode iniciar uma campanha.' });
      });
      client.on('auth_failure', () => { if (current()) this.update({ status: 'error', qr: null, account: null, message: 'Sessão expirada. Clique em Esquecer sessão e conecte novamente.' }); });
      client.on('disconnected', () => { if (current()) this.update({ status: 'disconnected', qr: null, account: null, message: 'A conexão caiu. A fila foi pausada; conecte novamente para continuar.' }); });
      client.on('message_ack', (message, ack) => { if (current()) this.emit('ack', { id: message.id?._serialized, ack }); });
      client.on('message', message => {
        if (!current() || message.fromMe || !/(@c\.us|@lid)$/.test(message.from || '')) return;
        const body = fold(message.body).replace(/[.!?]+$/, '').trim();
        if (!/^(sair|parar|cancelar|stop|remover|descadastrar|nao quero receber( mensagens)?|nao me envie( mais)? mensagens)$/.test(body)) return;
        // Block the observed identity immediately, before any asynchronous lookup.
        this.emit('optout', { identities: [message.from, ...(message.from.endsWith('@c.us') ? [message.from.split('@')[0]] : [])] });
        void timeout(client.getContactLidAndPhone([message.from]), 15000).then(contacts => {
          if (!current()) return;
          const identities = contacts.flatMap(contact => [contact.lid, contact.pn, contact.pn?.split('@')[0]]).filter(Boolean);
          this.emit('optout', { identities });
        }).catch(() => {});
      });
      void client.initialize().then(async () => {
        if (!current()) await client.destroy().catch(() => {});
      }).catch(async error => {
        if (!current()) { await client.destroy().catch(() => {}); return; }
        const browserMissing = /browser|chrome|chromium|executable|launch/i.test(error.message);
        this.update({ status: 'error', qr: null, account: null, message: browserMissing ? 'Não foi possível abrir o navegador. Instale o Chrome ou execute npm ci novamente. No Linux, confira as dependências do Chromium.' : 'Não foi possível conectar ao WhatsApp. Confira a internet e tente novamente.' });
        await client.destroy().catch(() => {});
      });
    } catch (error) {
      this.update({ status: 'error', qr: null, account: null, message: 'Falha ao iniciar. Confira a instalação e tente novamente.' });
      throw error;
    } finally { this.connecting = false; }
  }
  async resolve(phone) {
    requireValue(this.isReady(), 'WhatsApp desconectado.', 409);
    const result = await timeout(this.client.getNumberId(phone), 30000);
    return result?._serialized || null;
  }
  async send(jid, text) {
    requireValue(this.isReady(), 'WhatsApp desconectado.', 409);
    const client = this.client;
    try {
      const result = await timeout(client.sendMessage(jid, text, { sendSeen: false }), 60000);
      return { id: result?.id?._serialized, ack: result?.ack ?? 0 };
    } catch (error) {
      // A timed-out operation may already have sent. Terminate this session before another send.
      await this.close();
      throw error;
    }
  }
  async logout() {
    if (this.client && this.isReady()) await timeout(this.client.logout(), 15000).catch(() => {});
    await this.close();
    await fs.promises.rm(path.join(this.dataDir, 'session'), { recursive: true, force: true });
  }
  async close() {
    ++this.generation;
    const client = this.client;
    this.client = null;
    this.update({ status: 'disconnected', qr: null, account: null, message: 'Conecte seu WhatsApp para começar.' });
    if (client) {
      const browser = client.pupBrowser;
      try { await timeout(client.destroy(), 10000); }
      catch { browser?.process()?.kill(); }
    }
  }
}
