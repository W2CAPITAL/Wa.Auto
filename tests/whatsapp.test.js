import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsApp } from '../src/whatsapp.js';

class FakeLocalAuth {
  constructor(options) { this.options = options; }
}
class FakeClient extends EventEmitter {
  static instance;
  constructor(options) {
    super();
    this.options = options;
    this.info = { pushname: 'Conta Teste', wid: { user: '5511999990001' } };
    this.pupBrowser = { process: () => ({ kill() {} }) };
    FakeClient.instance = this;
  }
  async initialize() {
    if (this.options.pairWithPhoneNumber?.phoneNumber) this.emit('code', 'ABCD1234');
    else this.emit('qr', 'qr-code-test');
    await tick();
    this.emit('authenticated');
    this.emit('ready');
  }
  async getNumberId(phone) { return phone === '5511000000000' ? null : { _serialized: `${phone}@c.us` }; }
  async sendMessage(jid, text) { this.lastSend = { jid, text }; return { id: { _serialized: 'message-1' }, ack: 1 }; }
  async getContactLidAndPhone() { return [{ lid: 'lid-1@lid', pn: '5511999990001@c.us' }]; }
  async logout() { this.loggedOut = true; }
  async destroy() { this.destroyed = true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('WhatsApp: QR → autenticado → pronto → resolve → envia → ACK → opt-out → desconecta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-whatsapp-'));
  const states = []; const acks = []; const optouts = [];
  const transport = new WhatsApp(dir, {
    packageLoader: async () => ({ default: { Client: FakeClient, LocalAuth: FakeLocalAuth } }),
    qrEncoder: async code => `data:image/png;base64,${code}`,
  });
  transport.on('state', state => states.push({ ...state }));
  transport.on('ack', event => acks.push(event));
  transport.on('optout', event => optouts.push(event));
  await transport.connect();
  await tick();
  assert.ok(states.some(state => state.status === 'qr' && state.qr.includes('qr-code-test')));
  assert.ok(states.some(state => state.status === 'authenticated'));
  assert.equal(transport.snapshot().status, 'ready');
  assert.equal(transport.snapshot().account.phone, '5511999990001');
  assert.equal(await transport.resolve('5511999990002'), '5511999990002@c.us');
  assert.equal(await transport.resolve('5511000000000'), null);
  assert.deepEqual(await transport.send('5511999990002@c.us', 'Olá!'), { id: 'message-1', ack: 1 });
  assert.deepEqual(FakeClient.instance.lastSend, { jid: '5511999990002@c.us', text: 'Olá!' });
  FakeClient.instance.emit('message_ack', { id: { _serialized: 'message-1' } }, 2);
  assert.deepEqual(acks, [{ id: 'message-1', ack: 2 }]);
  FakeClient.instance.emit('message', { fromMe: false, from: '5511999990001@c.us', body: 'SAIR' });
  await tick();
  assert.ok(optouts.some(event => event.identities.includes('5511999990001@c.us')));
  FakeClient.instance.emit('disconnected', 'NAVIGATION');
  assert.equal(transport.snapshot().status, 'disconnected');
  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WhatsApp: pareamento por telefone gera código e chega ao estado pronto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-pairing-'));
  const states = [];
  const transport = new WhatsApp(dir, {
    packageLoader: async () => ({ default: { Client: FakeClient, LocalAuth: FakeLocalAuth } }),
    qrEncoder: async code => `data:image/png;base64,${code}`,
  });
  transport.on('state', state => states.push({ ...state }));
  await transport.connect({ phoneNumber: '5511999990001' });
  await tick();
  assert.equal(FakeClient.instance.options.pairWithPhoneNumber.phoneNumber, '5511999990001');
  assert.ok(states.some(state => state.status === 'pairing' && state.pairingCode === 'ABCD1234'));
  assert.equal(transport.snapshot().status, 'ready');
  assert.equal(transport.snapshot().pairingCode, null);
  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WhatsApp: falha de autenticação e erro de QR ficam visíveis ao usuário', async () => {
  class AuthFailClient extends FakeClient {
    async initialize() {
      this.emit('qr', 'bad-qr');
      await tick();
      this.emit('auth_failure', 'invalid');
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-whatsapp-fail-'));
  const transport = new WhatsApp(dir, {
    packageLoader: async () => ({ default: { Client: AuthFailClient, LocalAuth: FakeLocalAuth } }),
    qrEncoder: async () => { throw new Error('qr fail'); },
  });
  await transport.connect();
  await tick(); await tick();
  assert.equal(transport.snapshot().status, 'error');
  assert.match(transport.snapshot().message, /Sessão expirada|QR Code/);
  await transport.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
