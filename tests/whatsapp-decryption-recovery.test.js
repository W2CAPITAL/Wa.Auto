import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from 'node:fs';
const s=readFileSync(new URL('../src/whatsapp.js',import.meta.url),'utf8');
test('decrypted WhatsApp update is processed even without an ack status',()=>{assert.match(s,/if \(Number\.isFinite\(status\)\)/);assert.doesNotMatch(s,/if \(!id \|\| !Number\.isFinite\(status\)\) continue/);});
test('JID allowlist uses precise escaped WhatsApp domains',()=>{assert.ok(s.includes('/(@s\\.whatsapp\\.net|@lid)$/'));assert.doesNotMatch(s,/\\/\\(@s\\\\\\\\\\.whatsapp/);});
