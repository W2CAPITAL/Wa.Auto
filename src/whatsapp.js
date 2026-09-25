import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { fold } from './phone.js';
import { requireValue } from './errors.js';

const timeout = (promise, milliseconds) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('O WhatsApp demorou demais para responder.')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
};

const phoneFromJid = jid => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const normalizeJid = jid => String(jid || '').replace(/:\d+@/, '@');
function messageText(message) {
  let content = message?.message || {};
  if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  );
}

export class WhatsApp extends EventEmitter {
  constructor(dataDir, {
    packageLoader = () => import('@whiskeysockets/baileys'),
    qrEncoder = (code, options) => QRCode.toDataURL(code, options),
    onPersistentChange = () => {},
  } = {}) {
    super();
    this.dataDir = dataDir;
    this.packageLoader = packageLoader;
    this.qrEncoder = qrEncoder;
    this.onPersistentChange = onPersistentChange;
    this.state = { status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'Conecte seu WhatsApp para começar.' };
    this.generation = 0;
    this.connecting = false;
    this.manualClose = false;
    this.reconnectTimer = null;
  }

  snapshot() { return this.state; }
  isReady() { return this.state.status === 'ready'; }
  update(state) { this.state = { ...this.state, ...state }; this.emit('state', this.state); }
  persistSoon() { try { this.onPersistentChange(); } catch {} }

  async connect({ phoneNumber = null } = {}) {
    if (this.connecting || ['connecting', 'qr', 'pairing', 'authenticated', 'ready'].includes(this.state.status)) return;
    this.manualClose = false;
    this.connecting = true;
    clearTimeout(this.reconnectTimer);
    try {
      const generation = ++this.generation;
      const module = await this.packageLoader();
      const makeWASocket = module.default || module.makeWASocket;
      const { useMultiFileAuthState, Browsers = {}, DisconnectReason = {} } = module;
      requireValue(makeWASocket && useMultiFileAuthState, 'A integração cloud do WhatsApp não carregou corretamente.');

      const authDir = path.join(this.dataDir, 'baileys-auth');
      fs.mkdirSync(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const client = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu ? Browsers.ubuntu('WA.Auto') : ['WA.Auto', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: jid => String(jid || '').endsWith('@g.us'),
      });
      this.client = client;
      this.disconnectReason = DisconnectReason;
      const current = () => this.client === client && generation === this.generation;

      this.update({
        status: 'connecting',
        qr: null,
        pairingCode: null,
        account: null,
        message: phoneNumber ? 'Gerando código de pareamento…' : 'Conectando ao WhatsApp…',
      });

      client.ev.on('creds.update', async () => {
        if (!current()) return;
        await saveCreds();
        this.persistSoon();
      });

      client.ev.on('connection.update', update => {
        if (!current()) return;
        if (update.qr) {
          void this.qrEncoder(update.qr, { margin: 2, width: 280 }).then(qr => {
            if (current() && !['authenticated', 'ready'].includes(this.state.status)) {
              this.update({ status: 'qr', qr, pairingCode: null, message: 'Escaneie com WhatsApp → Aparelhos conectados → Conectar aparelho.' });
            }
          }).catch(() => {
            if (current()) this.update({ status: 'error', qr: null, message: 'Não foi possível gerar o QR Code. Tente novamente.' });
          });
        }

        if (update.connection === 'open') {
          const jid = client.user?.id || '';
          this.update({
            status: 'ready',
            qr: null,
            pairingCode: null,
            account: { name: client.user?.name || 'WhatsApp', phone: phoneFromJid(jid) },
            message: 'WhatsApp conectado na nuvem. Você já pode iniciar uma campanha.',
          });
          this.persistSoon();
        }

        if (update.connection === 'close') {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode || update.lastDisconnect?.error?.data?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
          this.client = null;
          if (loggedOut) {
            ++this.generation;
            void fs.promises.rm(path.join(this.dataDir, 'baileys-auth'), { recursive: true, force: true }).then(() => {
              this.update({ status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'A sessão expirou. Clique em Gerar QR Code para conectar novamente.' });
              this.persistSoon();
            }).catch(() => {
              this.update({ status: 'error', qr: null, pairingCode: null, account: null, message: 'A sessão expirou e não pôde ser limpa. Use Esquecer sessão e gere outro QR Code.' });
            });
          } else {
            this.update({ status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'A conexão caiu. A fila foi pausada e a reconexão será tentada automaticamente.' });
            if (!this.manualClose) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = setTimeout(() => void this.connect().catch(() => {}), 2500);
              this.reconnectTimer.unref?.();
            }
          }
        }
      });

      client.ev.on('messages.update', updates => {
        if (!current()) return;
        for (const item of updates || []) {
          const status = Number(item?.update?.status);
          const id = item?.key?.id;
          if (!id || !Number.isFinite(status)) continue;
          const ack = status <= 0 ? -1 : status >= 4 ? 3 : status === 3 ? 2 : status >= 2 ? 1 : 0;
          if (ack) this.emit('ack', { id, ack });
        }
        this.persistSoon();
      });

      client.ev.on('messages.upsert', ({ messages }) => {
        if (!current()) return;
        for (const message of messages || []) {
          if (message?.key?.fromMe) continue;
          const from = normalizeJid(message?.key?.remoteJid);
          if (!/(@s\.whatsapp\.net|@lid)$/.test(from)) continue;
          const body = fold(messageText(message)).replace(/[.!?]+$/, '').trim();
          if (!/^(sair|parar|cancelar|stop|remover|descadastrar|nao quero receber( mensagens)?|nao me envie( mais)? mensagens)$/.test(body)) continue;
          const phone = phoneFromJid(from);
          this.emit('optout', { identities: [from, phone].filter(Boolean) });
        }
        this.persistSoon();
      });

      if (phoneNumber && !state.creds?.registered) {
        const digits = String(phoneNumber).replace(/\D/g, '');
        const code = await timeout(client.requestPairingCode(digits), 30000);
        if (current()) this.update({
          status: 'pairing',
          qr: null,
          pairingCode: code,
          message: 'No WhatsApp, abra Aparelhos conectados → Conectar aparelho → Conectar com número de telefone e informe este código.',
        });
      }
    } catch (error) {
      this.client = null;
      this.update({ status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'A conexão com o WhatsApp falhou temporariamente. Você pode tentar novamente agora.' });
      if (!this.manualClose && !phoneNumber) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => void this.connect().catch(() => {}), 5000);
        this.reconnectTimer.unref?.();
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async resolve(phone) {
    requireValue(this.isReady(), 'WhatsApp desconectado.', 409);
    const rows = await timeout(this.client.onWhatsApp(String(phone)), 30000);
    const found = Array.isArray(rows) ? rows.find(row => row?.exists !== false && row?.jid) : null;
    return found?.jid ? normalizeJid(found.jid) : null;
  }

  async send(jid, text) {
    requireValue(this.isReady(), 'WhatsApp desconectado.', 409);
    const client = this.client;
    try {
      const result = await timeout(client.sendMessage(jid, { text }), 60000);
      this.persistSoon();
      return { id: result?.key?.id || result?.id, ack: 0 };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async logout() {
    clearTimeout(this.reconnectTimer);
    this.manualClose = true;
    const client = this.client;
    this.client = null;
    if (client?.logout) await timeout(client.logout(), 15000).catch(() => {});
    ++this.generation;
    await fs.promises.rm(path.join(this.dataDir, 'baileys-auth'), { recursive: true, force: true });
    this.update({ status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'Sessão removida. Gere um novo QR Code.' });
    this.persistSoon();
  }

  async close() {
    clearTimeout(this.reconnectTimer);
    this.manualClose = true;
    ++this.generation;
    const client = this.client;
    this.client = null;
    this.update({ status: 'disconnected', qr: null, pairingCode: null, account: null, message: 'Conecte seu WhatsApp para começar.' });
    if (client) {
      try { client.end?.(new Error('WA.Auto desconectado')); } catch {}
      try { client.ws?.close?.(); } catch {}
    }
  }
}
