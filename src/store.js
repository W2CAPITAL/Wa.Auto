import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireValue } from './errors.js';

const iso = () => new Date().toISOString();
export class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, filename TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, config TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_campaign ON campaigns(status) WHERE status='running';
      CREATE TABLE IF NOT EXISTS recipients(id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, row_num INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, raw_phone TEXT NOT NULL, data TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', message_id TEXT, jid TEXT, ack INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recipients_queue ON recipients(campaign_id,status,id);
      CREATE INDEX IF NOT EXISTS recipients_message ON recipients(message_id);
      CREATE TABLE IF NOT EXISTS suppressions(identity TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare("UPDATE campaigns SET status='paused',reason='Aplicativo reiniciado. Confira o histórico antes de continuar.' WHERE status='running'").run();
    this.db.prepare("UPDATE recipients SET status='uncertain',reason='O aplicativo fechou durante o envio. Confira a conversa; não haverá reenvio automático.' WHERE status='sending'").run();
    this.db.prepare("UPDATE recipients SET status='pending' WHERE status='resolving'").run();
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveImport(data) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO imports VALUES(?,?,?,?)').run(id, data.filename, JSON.stringify(data), iso());
    // The active campaign already contains its own frozen recipients and messages.
    this.db.prepare('DELETE FROM imports WHERE id NOT IN (SELECT id FROM imports ORDER BY created_at DESC LIMIT 5)').run();
    return id;
  }
  getImport(id) {
    const item = this.db.prepare('SELECT * FROM imports WHERE id=?').get(id);
    requireValue(item, 'A importação não está mais disponível. Importe o arquivo novamente.', 404);
    return { id: item.id, ...JSON.parse(item.data) };
  }
  latestImport() { return this.db.prepare('SELECT id,filename,created_at FROM imports ORDER BY created_at DESC LIMIT 1').get() || null; }
  createCampaign(name, config, entries) {
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare("INSERT INTO campaigns(id,name,created_at,status,config) VALUES(?,?,?,'draft',?)").run(id, name, iso(), JSON.stringify(config));
      const insert = this.db.prepare('INSERT INTO recipients(campaign_id,row_num,name,phone,raw_phone,data,message,status,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const entry of entries) insert.run(id, entry.row, entry.name, entry.phone, entry.rawPhone, JSON.stringify(entry.values), entry.message, entry.status, entry.reason || '', iso());
      return id;
    });
  }
  campaign(id) {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
    requireValue(row, 'Campanha não encontrada.', 404);
    return { ...row, config: JSON.parse(row.config), counts: this.counts(id) };
  }
  campaigns() { return this.db.prepare('SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 100').all().map(row => this.campaign(row.id)); }
  counts(id) { return Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM recipients WHERE campaign_id=? GROUP BY status').all(id).map(row => [row.status, row.count])); }
  entries(id) { return this.db.prepare('SELECT * FROM recipients WHERE campaign_id=? ORDER BY id').all(id).map(row => ({ ...row, values: JSON.parse(row.data), data: undefined })); }
  entry(id) { return this.db.prepare('SELECT * FROM recipients WHERE id=?').get(id); }
  active() { return this.db.prepare("SELECT id FROM campaigns WHERE status='running'").get()?.id || null; }
  setCampaign(id, status, reason = '') { this.db.prepare('UPDATE campaigns SET status=?,reason=? WHERE id=?').run(status, reason, id); }
  updateEntry(id, values) {
    const allowed = new Set(['status', 'reason', 'message_id', 'jid', 'ack']);
    const entries = Object.entries(values).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE recipients SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), iso(), id);
  }
  nextEntry(campaignId) { return this.db.prepare("SELECT * FROM recipients WHERE campaign_id=? AND status='pending' ORDER BY id LIMIT 1").get(); }
  hasSentJid(campaignId, jid, entryId) { return !!this.db.prepare("SELECT id FROM recipients WHERE campaign_id=? AND jid=? AND id<>? AND status IN ('sending','sent','delivered','read','uncertain','failed_delivery') LIMIT 1").get(campaignId, jid, entryId); }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  isBlocked(...identities) { const stmt = this.db.prepare('SELECT identity FROM suppressions WHERE identity=?'); return identities.filter(Boolean).some(value => !!stmt.get(value)); }
  suppress(identity, reason = 'Solicitação para não receber mensagens') {
    this.db.prepare('INSERT INTO suppressions VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET reason=excluded.reason').run(identity, reason, iso());
    this.db.prepare("UPDATE recipients SET status='skipped',reason=? WHERE (phone=? OR jid=?) AND status IN ('pending','resolving')").run(reason, identity, identity);
  }
  suppressions() { return this.db.prepare('SELECT * FROM suppressions ORDER BY created_at DESC').all(); }
  removeSuppression(identity) { this.db.prepare('DELETE FROM suppressions WHERE identity=?').run(identity); }
  recordAck(messageId, ack) {
    const row = this.db.prepare('SELECT * FROM recipients WHERE message_id=?').get(messageId);
    if (!row || !Number.isInteger(ack) || !['sent', 'delivered', 'read', 'failed_delivery'].includes(row.status)) return;
    if (ack === -1) {
      if (row.ack < 2) this.updateEntry(row.id, { status: 'failed_delivery', ack, reason: 'O WhatsApp informou falha de entrega. Confira a conversa.' });
      return;
    }
    if (ack <= row.ack) return;
    this.updateEntry(row.id, { status: ack >= 3 ? 'read' : ack === 2 ? 'delivered' : 'sent', ack, reason: '' });
  }
}
