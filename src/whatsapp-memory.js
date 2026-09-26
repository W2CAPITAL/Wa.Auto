import { requireValue } from './errors.js';

const iso = () => new Date().toISOString();
const phoneFromJid = jid => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const validIso = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const messageRow = row => row ? ({ ...row, is_from_me: !!row.is_from_me }) : null;

export class WhatsAppMemory {
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_chats(
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        is_group INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wa_messages(
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL REFERENCES wa_chats(jid) ON DELETE CASCADE,
        sender_jid TEXT NOT NULL DEFAULT '',
        sender_phone TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        is_from_me INTEGER NOT NULL DEFAULT 0,
        media_type TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wa_messages_chat_time ON wa_messages(chat_jid,timestamp DESC);
      CREATE INDEX IF NOT EXISTS wa_messages_sender ON wa_messages(sender_phone,timestamp DESC);
      CREATE INDEX IF NOT EXISTS wa_chats_last_active ON wa_chats(last_message_at DESC);
    `);
  }

  upsertContact({ jid, name = '', phone = '' } = {}) {
    const normalizedJid = String(jid || '').trim();
    if (!normalizedJid) return null;
    const now = iso();
    const normalizedPhone = String(phone || phoneFromJid(normalizedJid)).replace(/\D/g, '');
    this.db.prepare(`INSERT INTO wa_chats(jid,name,phone,is_group,last_message_at,updated_at)
      VALUES(?,?,?,?,NULL,?)
      ON CONFLICT(jid) DO UPDATE SET
        name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE wa_chats.name END,
        phone=CASE WHEN excluded.phone<>'' THEN excluded.phone ELSE wa_chats.phone END,
        updated_at=excluded.updated_at`)
      .run(normalizedJid, String(name || '').trim().slice(0,240), normalizedPhone.slice(0,32), normalizedJid.endsWith('@g.us') ? 1 : 0, now);
    return this.getChat(normalizedJid, false);
  }

  record({
    id, chatJid, senderJid = '', senderPhone = '', content = '', isFromMe = false,
    mediaType = null, timestamp = null, chatName = ''
  } = {}) {
    const messageId = String(id || '').trim();
    const jid = String(chatJid || '').trim();
    if (!messageId || !jid) return null;
    const at = validIso(timestamp) || iso();
    const now = iso();
    const phone = jid.endsWith('@g.us') ? '' : phoneFromJid(jid);

    this.db.prepare(`INSERT INTO wa_chats(jid,name,phone,is_group,last_message_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(jid) DO UPDATE SET
        name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE wa_chats.name END,
        phone=CASE WHEN excluded.phone<>'' THEN excluded.phone ELSE wa_chats.phone END,
        last_message_at=CASE WHEN wa_chats.last_message_at IS NULL OR excluded.last_message_at>wa_chats.last_message_at THEN excluded.last_message_at ELSE wa_chats.last_message_at END,
        updated_at=excluded.updated_at`)
      .run(jid, String(chatName || '').trim().slice(0,240), phone.slice(0,32), jid.endsWith('@g.us') ? 1 : 0, at, now);

    const fromJid = String(senderJid || (isFromMe ? '' : jid)).trim();
    const fromPhone = String(senderPhone || phoneFromJid(fromJid)).replace(/\D/g, '').slice(0,32);
    this.db.prepare(`INSERT INTO wa_messages(id,chat_jid,sender_jid,sender_phone,content,is_from_me,media_type,timestamp,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        chat_jid=excluded.chat_jid,
        sender_jid=CASE WHEN excluded.sender_jid<>'' THEN excluded.sender_jid ELSE wa_messages.sender_jid END,
        sender_phone=CASE WHEN excluded.sender_phone<>'' THEN excluded.sender_phone ELSE wa_messages.sender_phone END,
        content=CASE WHEN excluded.content<>'' THEN excluded.content ELSE wa_messages.content END,
        is_from_me=excluded.is_from_me,
        media_type=COALESCE(excluded.media_type,wa_messages.media_type),
        timestamp=excluded.timestamp`)
      .run(messageId, jid, fromJid, fromPhone, String(content || '').slice(0,12000), isFromMe ? 1 : 0, mediaType ? String(mediaType).slice(0,80) : null, at, now);

    return messageRow(this.db.prepare('SELECT * FROM wa_messages WHERE id=?').get(messageId));
  }

  searchContacts(query, limit = 50) {
    const term = String(query || '').trim().slice(0,200);
    if (!term) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 50, 100));
    const like = '%' + term.toLowerCase() + '%';
    const digits = term.replace(/\D/g,'');
    return this.db.prepare(`SELECT jid,name,phone,is_group,last_message_at
      FROM wa_chats
      WHERE is_group=0 AND (lower(name) LIKE ? OR lower(jid) LIKE ? OR phone LIKE ?)
      ORDER BY CASE WHEN name<>'' THEN 0 ELSE 1 END,name,jid LIMIT ?`)
      .all(like, like, '%' + digits + '%', capped)
      .map(row => ({ ...row, is_group: !!row.is_group }));
  }

  listMessages({
    after = null, before = null, sender_phone_number = null, chat_jid = null, query = null,
    limit = 20, page = 0, include_context = true, context_before = 1, context_after = 1
  } = {}) {
    const clauses = [];
    const params = [];
    const afterIso = validIso(after);
    const beforeIso = validIso(before);
    if (after) requireValue(afterIso, 'Data "after" inválida. Use ISO-8601.');
    if (before) requireValue(beforeIso, 'Data "before" inválida. Use ISO-8601.');
    if (afterIso) { clauses.push('m.timestamp>?'); params.push(afterIso); }
    if (beforeIso) { clauses.push('m.timestamp<?'); params.push(beforeIso); }
    if (sender_phone_number) {
      const digits = String(sender_phone_number).replace(/\D/g,'');
      clauses.push('(m.sender_phone=? OR m.sender_jid LIKE ?)');
      params.push(digits, '%' + digits + '%');
    }
    if (chat_jid) { clauses.push('m.chat_jid=?'); params.push(String(chat_jid)); }
    if (query) { clauses.push('lower(m.content) LIKE ?'); params.push('%' + String(query).toLowerCase().slice(0,500) + '%'); }

    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    const offset = Math.max(0, Math.min(Number(page) || 0, 10000)) * capped;
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT m.*,c.name AS chat_name,c.is_group
      FROM wa_messages m JOIN wa_chats c ON c.jid=m.chat_jid
      ${where} ORDER BY m.timestamp DESC,m.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, capped, offset)
      .map(row => ({ ...messageRow(row), is_group: !!row.is_group }));

    if (!include_context) return rows;
    const b = Math.max(0, Math.min(Number(context_before) || 0, 20));
    const a = Math.max(0, Math.min(Number(context_after) || 0, 20));
    return rows.map(row => ({ ...row, context: this.getMessageContext(row.id, b, a) }));
  }

  listChats({
    query = null, limit = 20, page = 0, include_last_message = true, sort_by = 'last_active'
  } = {}) {
    const params = [];
    let where = '';
    if (query) {
      const text = String(query).slice(0,300);
      const like = '%' + text.toLowerCase() + '%';
      where = 'WHERE lower(c.name) LIKE ? OR lower(c.jid) LIKE ? OR c.phone LIKE ?';
      params.push(like, like, '%' + text.replace(/\D/g,'') + '%');
    }
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    const offset = Math.max(0, Math.min(Number(page) || 0, 10000)) * capped;
    const order = sort_by === 'name'
      ? "CASE WHEN c.name='' THEN c.jid ELSE c.name END COLLATE NOCASE ASC"
      : 'c.last_message_at DESC';

    const rows = this.db.prepare(`SELECT c.*,
      m.id AS last_message_id,m.content AS last_message,m.sender_jid AS last_sender,
      m.is_from_me AS last_is_from_me,m.media_type AS last_media_type
      FROM wa_chats c
      LEFT JOIN wa_messages m ON m.id=(SELECT id FROM wa_messages x WHERE x.chat_jid=c.jid ORDER BY x.timestamp DESC,x.created_at DESC LIMIT 1)
      ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, capped, offset);

    return rows.map(row => {
      const item = { ...row, is_group: !!row.is_group, last_is_from_me: row.last_is_from_me == null ? null : !!row.last_is_from_me };
      if (!include_last_message) {
        delete item.last_message_id;
        delete item.last_message;
        delete item.last_sender;
        delete item.last_is_from_me;
        delete item.last_media_type;
      }
      return item;
    });
  }

  getChat(jid, includeLastMessage = true) {
    const target = String(jid || '');
    const row = this.db.prepare('SELECT jid FROM wa_chats WHERE jid=?').get(target);
    if (!row) return null;
    const result = this.listChats({ query: target, limit: 20, include_last_message: includeLastMessage });
    return result.find(item => item.jid === target) || null;
  }

  getDirectChat(phone) {
    const digits = String(phone || '').replace(/\D/g,'');
    if (!digits) return null;
    const row = this.db.prepare("SELECT jid FROM wa_chats WHERE is_group=0 AND (phone=? OR jid LIKE ?) ORDER BY last_message_at DESC LIMIT 1")
      .get(digits, '%' + digits + '%');
    return row ? this.getChat(row.jid, true) : null;
  }

  getContactChats(jid, limit = 20, page = 0) {
    const target = String(jid || '').trim();
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    const offset = Math.max(0, Math.min(Number(page) || 0, 10000)) * capped;
    const rows = this.db.prepare(`SELECT DISTINCT c.jid
      FROM wa_chats c LEFT JOIN wa_messages m ON m.chat_jid=c.jid
      WHERE c.jid=? OR m.sender_jid=?
      ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?`).all(target, target, capped, offset);
    return rows.map(row => this.getChat(row.jid, true)).filter(Boolean);
  }

  getLastInteraction(jid) {
    const target = String(jid || '').trim();
    const digits = phoneFromJid(target);
    const row = this.db.prepare(`SELECT m.*,c.name AS chat_name,c.is_group
      FROM wa_messages m JOIN wa_chats c ON c.jid=m.chat_jid
      WHERE m.chat_jid=? OR m.sender_jid=? OR (?<>'' AND m.sender_phone=?)
      ORDER BY m.timestamp DESC,m.created_at DESC LIMIT 1`).get(target, target, digits, digits);
    return row ? ({ ...messageRow(row), is_group: !!row.is_group }) : null;
  }

  getMessageContext(messageId, before = 5, after = 5) {
    const target = this.db.prepare(`SELECT m.*,c.name AS chat_name,c.is_group
      FROM wa_messages m JOIN wa_chats c ON c.jid=m.chat_jid WHERE m.id=?`).get(String(messageId || ''));
    requireValue(target, 'Mensagem não encontrada no histórico atual.', 404);

    const b = Math.max(0, Math.min(Number(before) || 0, 50));
    const a = Math.max(0, Math.min(Number(after) || 0, 50));
    const previous = this.db.prepare(`SELECT * FROM wa_messages
      WHERE chat_jid=? AND (timestamp<? OR (timestamp=? AND created_at<?))
      ORDER BY timestamp DESC,created_at DESC LIMIT ?`)
      .all(target.chat_jid, target.timestamp, target.timestamp, target.created_at, b)
      .reverse()
      .map(messageRow);
    const next = this.db.prepare(`SELECT * FROM wa_messages
      WHERE chat_jid=? AND (timestamp>? OR (timestamp=? AND created_at>?))
      ORDER BY timestamp ASC,created_at ASC LIMIT ?`)
      .all(target.chat_jid, target.timestamp, target.timestamp, target.created_at, a)
      .map(messageRow);

    return {
      message: { ...messageRow(target), is_group: !!target.is_group },
      before: previous,
      after: next,
    };
  }

  prune(retentionDays = 30) {
    const days = Math.max(0, Math.min(Number(retentionDays) || 0, 3650));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const messages = this.db.prepare('DELETE FROM wa_messages WHERE timestamp<?').run(cutoff).changes;
    const chats = this.db.prepare('DELETE FROM wa_chats WHERE NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.chat_jid=wa_chats.jid)').run().changes;
    return { messages, chats, cutoff };
  }

  stats() {
    return {
      chats: Number(this.db.prepare('SELECT COUNT(*) AS n FROM wa_chats').get()?.n || 0),
      messages: Number(this.db.prepare('SELECT COUNT(*) AS n FROM wa_messages').get()?.n || 0),
      lastMessageAt: this.db.prepare('SELECT MAX(timestamp) AS value FROM wa_messages').get()?.value || null,
    };
  }
}
