import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { gridToSheet } from '../src/importer.js';
import { createCampaign } from '../src/campaigns.js';

export class TestTransport extends EventEmitter {
  constructor() { super(); this.ready = true; this.sent = []; }
  isReady() { return this.ready; }
  snapshot() { return { status: this.ready ? 'ready' : 'disconnected', account: { name: 'Teste isolado', phone: '' } }; }
  async resolve(phone) { return `${phone}@s.whatsapp.net`; }
  async send(jid, message) { this.sent.push({ jid, message }); return { id: `test-${this.sent.length}`, ack: 1 }; }
  async connect(options = {}) { this.lastConnectOptions = options; this.ready = true; this.emit('state', this.snapshot()); }
  async close() { this.ready = false; this.emit('state', this.snapshot()); }
  async logout() { await this.close(); }
}
export function fixture(filename = ':memory:', grid = [['Cliente','Telefone','Autorizado','Observacoes'], ['Ana','11999990001','sim',''], ['Bia','21999990002','sim','']]) {
  const store = new Store(filename);
  const id = store.saveImport({ filename: 'teste.csv', sheets: [gridToSheet('Clientes', grid)] });
  const input = { importId: id, sheet: 'Clientes', phoneColumn: 'Telefone', nameColumn: 'Cliente', template: 'Olá, {{Cliente}}!', country: '55', name: 'Campanha de teste', intervalSeconds: 30 };
  return { store, input, create: (extra = {}) => createCampaign(store, { ...input, ...extra }) };
}
