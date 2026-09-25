import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteSnapshot } from '../src/remote-snapshot.js';

test('RemoteSnapshot: salva e restaura arquivos cloud sem lock/WAL', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-snapshot-src-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-snapshot-dst-'));
  fs.mkdirSync(path.join(source, 'baileys-auth'), { recursive: true });
  fs.writeFileSync(path.join(source, 'wa-auto.sqlite'), 'db-content');
  fs.writeFileSync(path.join(source, 'wa-auto.sqlite-wal'), 'skip-me');
  fs.writeFileSync(path.join(source, 'app.lock'), 'skip-me');
  fs.writeFileSync(path.join(source, 'baileys-auth', 'creds.json'), '{"ok":true}');
  let row = null;
  let checkpoints = 0;
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify(row ? [row] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = JSON.parse(options.body);
    row = body[0];
    return new Response('', { status: 201 });
  };
  const snapshot = new RemoteSnapshot({ url: 'https://example.supabase.co', key: 'anon', secret: 'secret', fetchImpl });
  await snapshot.save(source, { checkpoint() { checkpoints++; } });
  assert.equal(checkpoints, 1);
  assert.ok(row?.payload);
  assert.equal(await snapshot.restore(target), true);
  assert.equal(fs.readFileSync(path.join(target, 'wa-auto.sqlite'), 'utf8'), 'db-content');
  assert.equal(fs.readFileSync(path.join(target, 'baileys-auth', 'creds.json'), 'utf8'), '{"ok":true}');
  assert.equal(fs.existsSync(path.join(target, 'wa-auto.sqlite-wal')), false);
  assert.equal(fs.existsSync(path.join(target, 'app.lock')), false);
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});
