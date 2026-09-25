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
      CREATE TABLE IF NOT EXISTS legal_monitors(
        id TEXT PRIMARY KEY,
        cnj TEXT NOT NULL,
        client_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        tribunal_alias TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'both',
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_whatsapp INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_event_at TEXT,
        last_event_hash TEXT,
        last_event_source TEXT,
        last_event_text TEXT,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS legal_monitor_unique ON legal_monitors(cnj,phone);
      CREATE TABLE IF NOT EXISTS legal_events(
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES legal_monitors(id) ON DELETE CASCADE,
        event_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        event_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        send_status TEXT NOT NULL DEFAULT 'waiting',
        message_id TEXT,
        sent_at TEXT,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS legal_event_unique ON legal_events(monitor_id,event_hash);
      CREATE INDEX IF NOT EXISTS legal_events_pending ON legal_events(send_status,event_at);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare("UPDATE campaigns SET status='paused',reason='Aplicativo reiniciado. Confira o histórico antes de continuar.' WHERE status='running'").run();
    this.db.prepare("UPDATE recipients SET status='uncertain',reason='O aplicativo fechou durante o envio. Confira a conversa; não haverá reenvio automático.' WHERE status='sending'").run();
    this.db.prepare("UPDATE recipients SET status='pending' WHERE status='resolving'").run();
    this.db.prepare("UPDATE legal_events SET send_status='uncertain',error='O servidor reiniciou durante o envio. O aviso não será reenviado automaticamente.' WHERE send_status='sending'").run();
  }
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(FULL)'); } catch {} }
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
  nextEntry(campaignId) { return this.db.prepare("SELECT * FROM recipients WHERE campaign_id=? AND status='pending' ORDER BY id LIMIT 1").get(campaignId); }
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

  createLegalMonitor({ cnj, clientName, phone, tribunalAlias = '', mode = 'both', notifyWhatsapp = true }) {
    const now = iso();
    const existing = this.db.prepare('SELECT id FROM legal_monitors WHERE cnj=? AND phone=?').get(cnj, phone);
    const id = existing?.id || randomUUID();
    this.db.prepare(`INSERT INTO legal_monitors(
      id,cnj,client_name,phone,tribunal_alias,mode,enabled,notify_whatsapp,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,1,?,?,?)
    ON CONFLICT(cnj,phone) DO UPDATE SET
      client_name=excluded.client_name,
      tribunal_alias=excluded.tribunal_alias,
      mode=excluded.mode,
      notify_whatsapp=excluded.notify_whatsapp,
      enabled=1,
      updated_at=excluded.updated_at`).run(id, cnj, clientName, phone, tribunalAlias, mode, notifyWhatsapp ? 1 : 0, now, now);
    return this.legalMonitor(id);
  }
  legalMonitor(id) {
    const row = this.db.prepare('SELECT * FROM legal_monitors WHERE id=?').get(id);
    requireValue(row, 'Monitor processual não encontrado.', 404);
    return { ...row, enabled: !!row.enabled, notify_whatsapp: !!row.notify_whatsapp };
  }
  legalMonitors() {
    return this.db.prepare('SELECT * FROM legal_monitors ORDER BY created_at DESC').all().map(row => ({ ...row, enabled: !!row.enabled, notify_whatsapp: !!row.notify_whatsapp }));
  }
  updateLegalMonitor(id, values = {}) {
    const allowed = new Set(['client_name','phone','tribunal_alias','mode','enabled','notify_whatsapp','last_checked_at','last_event_at','last_event_hash','last_event_source','last_event_text','error']);
    const entries = Object.entries(values).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.legalMonitor(id);
    const normalized = entries.map(([key, value]) => [key, ['enabled','notify_whatsapp'].includes(key) ? (value ? 1 : 0) : value]);
    this.db.prepare(`UPDATE legal_monitors SET ${normalized.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...normalized.map(([,value]) => value), iso(), id);
    return this.legalMonitor(id);
  }
  deleteLegalMonitor(id) { this.db.prepare('DELETE FROM legal_monitors WHERE id=?').run(id); }
  hasLegalEvent(monitorId, eventHash) { return !!this.db.prepare('SELECT id FROM legal_events WHERE monitor_id=? AND event_hash=?').get(monitorId, eventHash); }
  recordLegalEvent({ monitorId, eventHash, source, title, details = '', eventAt, sendStatus = 'waiting' }) {
    const id = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO legal_events(id,monitor_id,event_hash,source,title,details,event_at,created_at,send_status)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, monitorId, eventHash, source, title, details, eventAt, iso(), sendStatus);
    return this.db.prepare('SELECT * FROM legal_events WHERE monitor_id=? AND event_hash=?').get(monitorId, eventHash);
  }
  legalEvents(monitorId = null, limit = 200) {
    const capped = Math.max(1, Math.min(Number(limit) || 200, 500));
    return monitorId
      ? this.db.prepare('SELECT * FROM legal_events WHERE monitor_id=? ORDER BY event_at DESC,created_at DESC LIMIT ?').all(monitorId, capped)
      : this.db.prepare('SELECT * FROM legal_events ORDER BY event_at DESC,created_at DESC LIMIT ?').all(capped);
  }
  pendingLegalEvents(limit = 25) {
    return this.db.prepare(`SELECT e.*,m.cnj,m.client_name,m.phone,m.notify_whatsapp,m.enabled
      FROM legal_events e JOIN legal_monitors m ON m.id=e.monitor_id
      WHERE e.send_status='waiting' AND m.enabled=1 AND m.notify_whatsapp=1
      ORDER BY e.event_at ASC LIMIT ?`).all(Math.max(1, Math.min(Number(limit) || 25, 100)));
  }
  markLegalEvent(id, { sendStatus, messageId = null, error = '' }) {
    this.db.prepare('UPDATE legal_events SET send_status=?,message_id=?,sent_at=?,error=? WHERE id=?')
      .run(sendStatus, messageId, sendStatus === 'sent' ? iso() : null, error, id);
  }
  recoverCriticalIntent(intent) {
    if (!intent?.kind || !intent?.payload) return { recovered:false };
    if (intent.kind === 'campaign') {
      const entryId = Number(intent.payload.entryId);
      const row = Number.isInteger(entryId) ? this.entry(entryId) : null;
      if (row && ['pending','resolving','sending'].includes(row.status)) {
        this.updateEntry(entryId, {
          status:'uncertain',
          reason:'O servidor reiniciou perto do momento do envio. Confira a conversa; o WA.Auto não reenviará automaticamente.'
        });
        const campaign = this.campaign(row.campaign_id);
        if (campaign.status === 'running') this.setCampaign(row.campaign_id, 'paused', 'Envio interrompido por reinício. Confira a linha marcada antes de continuar.');
        return { recovered:true, kind:'campaign', entryId };
      }
      return { recovered:false, kind:'campaign', entryId };
    }
    if (intent.kind === 'legal') {
      const ids = Array.isArray(intent.payload.eventIds) ? intent.payload.eventIds.map(String) : [];
      let changed = 0;
      const get = this.db.prepare('SELECT id,send_status FROM legal_events WHERE id=?');
      for (const id of ids) {
        const event = get.get(id);
        if (event && ['waiting','sending'].includes(event.send_status)) {
          this.markLegalEvent(id, {
            sendStatus:'uncertain',
            error:'O servidor reiniciou perto do envio deste alerta. Ele não será reenviado automaticamente.'
          });
          changed++;
        }
      }
      return { recovered:changed > 0, kind:'legal', events:changed };
    }
    return { recovered:false };
  }

  pruneHistory(retentionDays = 30) {
    const days = Math.max(0, Math.min(Number(retentionDays) || 0, 3650));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return this.transaction(() => {
      // Keep the legal event hash/source/date as a tiny deduplication tombstone.
      // Removing the row entirely would make an old tribunal event look "new" again.
      const legalScrubbed = this.db.prepare(`UPDATE legal_events
        SET details='', title='Movimentação processual arquivada'
        WHERE created_at<? AND send_status NOT IN ('waiting','sending','uncertain')
          AND (details<>'' OR title<>'Movimentação processual arquivada')`).run(cutoff).changes;
      const campaigns = this.db.prepare("DELETE FROM campaigns WHERE created_at<? AND status IN ('completed','cancelled')").run(cutoff).changes;
      return { legalScrubbed, campaigns, cutoff };
    });
  }
  legalStats() {
    const monitored = Number(this.db.prepare('SELECT COUNT(*) AS n FROM legal_monitors WHERE enabled=1').get()?.n || 0);
    const alerts = Number(this.db.prepare("SELECT COUNT(*) AS n FROM legal_events WHERE send_status IN ('waiting','failed')").get()?.n || 0);
    const sent = Number(this.db.prepare("SELECT COUNT(*) AS n FROM legal_events WHERE send_status='sent'").get()?.n || 0);
    const lastScan = this.getMeta('legalLastScanAt') || null;
    return { monitored, alerts, sent, lastScan };
  }

  cancelPending(campaignId) { this.db.prepare("UPDATE recipients SET status='cancelled',reason='Campanha cancelada',updated_at=? WHERE campaign_id=? AND status IN ('pending','resolving')").run(iso(), campaignId); }
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
