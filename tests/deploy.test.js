import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('deploy cloud usa Render e não depende de localhost no navegador', () => {
  const render = fs.readFileSync('render.yaml', 'utf8');
  assert.match(render, /type:\s*web/);
  assert.match(render, /plan:\s*free/);
  assert.match(render, /WA_HOSTED/);
  assert.match(render, /SUPABASE_URL/);
  assert.match(render, /WA_DB_SECRET/);
  assert.match(render, /healthCheckPath:\s*\/api\/health/);

  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.doesNotMatch(app, /127\.0\.0\.1:3210/);
  assert.doesNotMatch(app, /targetAddressSpace/);
  assert.match(app, /fetch\(apiUrl\(url\)/);
});
