import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsApp } from '../src/whatsapp.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeSocket {
  static instance;
  constructor({ autoOpen = true } = {}) {
    this.ev = new EventEmitter();
    this.user = { id: '5511999990001:12@s.whatsapp.net', name: 'Conta Teste' };
    this.ws = { close: () => { this.closed = true; } };
    FakeSocket.instance = this;
    if (autoOpen) {
      setImmediate(() => {
        this.ev.emit('connection.update', { qr: 'qr-code-test' });
        setImmediate(() => this.ev.emit('connection.update', { connection: 'open' }));
      });
    }
  }
  async requestPairingCode(phone) { this.pairPhone = phone; return 'ABCD1234'; }
  async onWhatsApp(phone) { return phone === '5511000000000' ? [] : [{ exists: true, jid: `${phone}@s.whatsapp.net` }]; }
  async sendMessage(jid, content) {
    this.lastSend = { jid, content };
    return { key: { id: 'message-1' } };
  }
  async logout() { this.loggedOut = true; }
  end() { this.ended = true; }
}
function fakePackage({ autoOpen = true, registered = false } = {}) {
  return {
    default: () => new FakeSocket({ autoOpen }),
    useMultiFileAuthState: async () => ({
      state: { creds: { registered } },
      saveCreds: async () => {},
    }),
    Browsers: { ubuntu: name => [name, 'Chrome', '1.0.0'] },
    DisconnectReason: { loggedOut: 401 },
  };
}

test('WhatsApp cloud: QR → pronto → resolve → envia → ACK → opt-out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-baileys-'));
  const states = []; const acks = []; const optouts = []; let persisted = 0;
  const transport = new WhatsApp(dir, {
    packageLoader: async () => fakePackage(),
    qrEncoder: async code => `data:image/png;base64,${code}`,
    onPersistentChange: () => { persisted++; },
  });
  transport.on('state', state => states.push({ ...state }));
  transport.on('ack', event => acks.push(event));
  transport.on('optout', event => optouts.push(event));

  await transport.connect();
  await tick(); await tick(); await tick();
  assert.ok(states.some(state => state.status === 'qr' && state.qr.includes('qr-code-test')));
  assert.equal(transport.snapshot().status, 'ready');
  assert.equal(transport.snapshot().account.phone, '5511999990001');
  assert.equal(await transport.resolve('5511999990002'), '5511999990002@s.whatsapp.net');
  assert.equal(await transport.resolve('5511000000000'), null);
  assert.deepEqual(await transport.send('5511999990002@s.whatsapp.net', 'Olá!'), { id: 'message-1', ack: 0 });
  assert.deepEqual(FakeSocket.instance.lastSend, { jid: '5511999990002@s.whatsapp.net', content: { text: 'Olá!' } });

  FakeSocket.instance.ev.emit('messages.update', [{ key: { id: 'message-1' }, update: { status: 3 } }]);
  assert.deepEqual(acks, [{ id: 'message-1', ack: 2 }]);

  FakeSocket.instance.ev.emit('messages.upsert', { messages: [{ key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net' }, message: { conversation: 'SAIR' } }] });
  assert.ok(optouts.some(event => event.identities.includes('5511999990001')));
  assert.ok(persisted > 0);

  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WhatsApp cloud: pareamento por telefone gera código', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-pairing-'));
  const transport = new WhatsApp(dir, {
    packageLoader: async () => fakePackage({ autoOpen: false }),
    qrEncoder: async code => `data:image/png;base64,${code}`,
  });
  await transport.connect({ phoneNumber: '5511999990001' });
  assert.equal(FakeSocket.instance.pairPhone, '5511999990001');
  assert.equal(transport.snapshot().status, 'pairing');
  assert.equal(transport.snapshot().pairingCode, 'ABCD1234');
  FakeSocket.instance.ev.emit('connection.update', { connection: 'open' });
  assert.equal(transport.snapshot().status, 'ready');
  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WhatsApp cloud: logout remoto exige novo QR e QR inválido mostra erro', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-baileys-fail-'));
  const transport = new WhatsApp(dir, {
    packageLoader: async () => fakePackage({ autoOpen: false }),
    qrEncoder: async () => { throw new Error('qr fail'); },
  });
  await transport.connect();
  FakeSocket.instance.ev.emit('connection.update', { qr: 'bad-qr' });
  await tick();
  assert.equal(transport.snapshot().status, 'error');
  FakeSocket.instance.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(transport.snapshot().status, 'error');
  assert.match(transport.snapshot().message, /novo QR Code/i);
  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
