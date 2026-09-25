import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function walkFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) {
      const rel = path.relative(root, full).replaceAll('\\', '/');
      if (rel === 'app.lock' || rel.endsWith('-wal') || rel.endsWith('-shm')) continue;
      out.push({ path: rel, data: fs.readFileSync(full).toString('base64') });
    }
  }
  return out;
}

function unpack(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const file of files || []) {
    if (!file?.path || file.path.includes('..') || path.isAbsolute(file.path)) continue;
    const full = path.join(root, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(file.data, 'base64'));
  }
}

export class RemoteSnapshot {
  constructor({
    url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
    secret = process.env.WA_DB_SECRET,
    fetchImpl = fetch,
  } = {}) {
    this.url = String(url || '').replace(/\/$/, '');
    this.key = key || '';
    this.secret = secret || '';
    this.fetch = fetchImpl;
    this.timer = null;
    this.saving = null;
    this.dirty = false;
    this.intentActive = false;
    this.intentArmed = false;
  }

  get configured() { return !!(this.url && this.key && this.secret); }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'x-wa-secret': this.secret,
      ...extra,
    };
  }

  async getIntent() {
    if (!this.configured) return null;
    const response = await this.fetch(`${this.url}/rest/v1/wa_auto_intents?id=eq.active&select=kind,payload,created_at&limit=1`, {
      headers: this.headers({ Accept: 'application/json' }),
    });
    if (!response.ok) throw new Error(`Falha ao consultar o diário de envio crítico (${response.status}).`);
    const rows = await response.json();
    return rows?.[0] || null;
  }

  async beginIntent(kind, payload) {
    if (!this.configured) throw new Error('Persistência remota indisponível para registrar o envio.');
    const existing = await this.getIntent();
    if (existing) throw new Error('Existe um envio anterior ainda em recuperação. Aguarde a persistência concluir.');
    const response = await this.fetch(`${this.url}/rest/v1/wa_auto_intents?on_conflict=id`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify([{ id: 'active', kind, payload, created_at: new Date().toISOString() }]),
    });
    if (!response.ok) throw new Error(`Falha ao proteger o envio contra reinício (${response.status}).`);
    this.intentActive = true;
    this.intentArmed = false;
  }

  armIntent() {
    if (this.intentActive) this.intentArmed = true;
  }

  async clearIntent() {
    if (!this.configured) return;
    const response = await this.fetch(`${this.url}/rest/v1/wa_auto_intents?id=eq.active`, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    if (!response.ok) throw new Error(`Falha ao limpar o diário de envio crítico (${response.status}).`);
    this.intentActive = false;
    this.intentArmed = false;
  }

  async restore(dataDir) {
    if (!this.configured) throw new Error('Hospedagem cloud sem persistência configurada. Defina SUPABASE_URL, SUPABASE_ANON_KEY e WA_DB_SECRET.');
    const response = await this.fetch(`${this.url}/rest/v1/wa_auto_snapshots?id=eq.default&select=payload&limit=1`, {
      headers: this.headers({ Accept: 'application/json' }),
    });
    if (!response.ok) throw new Error(`Falha ao restaurar estado remoto (${response.status}).`);
    const rows = await response.json();
    if (!rows?.length || !rows[0].payload) return false;
    const packed = Buffer.from(rows[0].payload, 'base64');
    const files = JSON.parse(zlib.gunzipSync(packed).toString('utf8'));
    unpack(dataDir, files);
    return true;
  }

  async save(dataDir, store) {
    if (!this.configured) return;
    if (this.saving) {
      this.dirty = true;
      await this.saving;
      return;
    }
    this.saving = (async () => {
      try {
        store?.checkpoint?.();
        const files = walkFiles(dataDir);
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
        const response = await this.fetch(`${this.url}/rest/v1/wa_auto_snapshots?on_conflict=id`, {
          method: 'POST',
          headers: this.headers({
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          }),
          body: JSON.stringify([{ id: 'default', payload, updated_at: new Date().toISOString() }]),
        });
        if (!response.ok) throw new Error(`Falha ao salvar estado remoto (${response.status}): ${await response.text()}`);
        if (this.intentActive && this.intentArmed) await this.clearIntent();
      } finally {
        this.saving = null;
      }
      if (this.dirty) {
        this.dirty = false;
        await sleep(50);
        await this.save(dataDir, store);
      }
    })();
    await this.saving;
  }

  schedule(dataDir, store, delay = 1200) {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dirty = false;
      void this.save(dataDir, store).catch(error => console.error('Falha ao persistir snapshot remoto:', error.message));
    }, delay);
    this.timer.unref?.();
  }

  async close(dataDir, store) {
    clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    await this.save(dataDir, store);
  }
}
