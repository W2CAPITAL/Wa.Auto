import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('deploy Vercel publica somente o painel estático e aponta para o motor local', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.match(config.buildCommand, /hosted panel ready/);
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.match(app, /http:\/\/127\.0\.0\.1:3210/);
  assert.match(app, /targetAddressSpace:\s*'local'/);
});
