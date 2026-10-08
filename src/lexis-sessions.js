import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WhatsApp } from './whatsapp.js';
import { WhatsAppMemory } from './whatsapp-memory.js';
import { requireValue } from './errors.js';

const safeKey = userId =>
  createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 32);

export class LexisSessionManager {
  constructor(rootDir, {
    onPersistentChange = () => {},
    maxSessions = Number(process.env.WA_LEXIS_MAX_SESSIONS || 25),
  } = {}) {
    this.rootDir = rootDir;
    this.onPersistentChange = onPersistentChange;
    this.maxSessions = Math.max(2, Math.min(Number(maxSessions) || 25, 100));
    this.sessions = new Map();
    fs.mkdirSync(rootDir, { recursive: true });
  }

  touch() {
    try { this.onPersistentChange(); } catch {}
  }

  create(userId) {
    const owner = String(userId || '').trim();
    requireValue(owner, 'Sessão LexisPredict sem usuário.', 401);

    if (this.sessions.size >= this.maxSessions) {
      const idle = [...this.sessions.entries()]
        .filter(([, session]) => !session.transport.isReady() && !session.transport.connecting)
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
      if (idle) {
        const [key, session] = idle;
        void session.transport.close().catch(() => {});
        try { session.db.close(); } catch {}
        this.sessions.delete(key);
      }
    }

    requireValue(
      this.sessions.size < this.maxSessions,
      'Limite temporário de sessões WhatsApp atingido. Tente novamente em alguns minutos.',
      503,
    );

    const key = safeKey(owner);
    const dir = path.join(this.rootDir, key);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, 'owner.json'),
        JSON.stringify({ userId: owner, updatedAt: new Date().toISOString() }),
      );
    } catch {}

    const db = new DatabaseSync(path.join(dir, 'history.sqlite'));
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const memory = new WhatsAppMemory(db);
    const transport = new WhatsApp(dir, {
      onPersistentChange: () => this.touch(),
    });

    const session = {
      key,
      userId: owner,
      dir,
      db,
      memory,
      transport,
      lastAccess: Date.now(),
      restoring: false,
    };

    transport.on('state', state => {
      session.lastAccess = Date.now();
      console.log(`Lexis WhatsApp ${key.slice(0, 8)} state: ${state.status}`);
    });
    transport.on('message', message => {
      memory.record(message);
      session.lastAccess = Date.now();
      this.touch();
    });
    transport.on('contact', contact => {
      memory.upsertContact(contact);
      session.lastAccess = Date.now();
      this.touch();
    });

    this.sessions.set(key, session);
    return session;
  }

  get(userId, { autoConnect = true } = {}) {
    const owner = String(userId || '').trim();
    requireValue(owner, 'Sessão LexisPredict sem usuário.', 401);
    const key = safeKey(owner);
    let session = this.sessions.get(key);
    if (!session) session = this.create(owner);
    session.lastAccess = Date.now();

    if (
      autoConnect &&
      session.transport.hasStoredAuth() &&
      !session.transport.isReady() &&
      !session.transport.connecting &&
      !session.restoring
    ) {
      session.restoring = true;
      void session.transport
        .connect()
        .catch(error =>
          console.warn(`Falha ao restaurar WhatsApp Lexis ${key.slice(0, 8)}:`, error?.message || error),
        )
        .finally(() => {
          session.restoring = false;
        });
    }

    return session;
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      try { await session.transport.close(); } catch {}
      try { session.db.close(); } catch {}
    }
    this.sessions.clear();
  }

  stats() {
    const sessions = [...this.sessions.values()];
    return {
      active: sessions.length,
      ready: sessions.filter(session => session.transport.isReady()).length,
      max: this.maxSessions,
    };
  }
}
