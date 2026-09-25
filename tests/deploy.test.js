import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('deploy é exclusivamente cloud e não depende de localhost/Windows no navegador ou servidor', () => {
  const render = fs.readFileSync('render.yaml', 'utf8');
  assert.match(render, /type:\s*web/);
  assert.match(render, /plan:\s*free/);
  assert.match(render, /SUPABASE_URL/);
  assert.match(render, /SUPABASE_(ANON_KEY|PUBLISHABLE_KEY)/);
  assert.match(render, /WA_DB_SECRET/);
  assert.match(render, /healthCheckPath:\s*\/api\/health/);
  assert.doesNotMatch(render, /WA_HOSTED/);

  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.doesNotMatch(app, /127\.0\.0\.1|localhost|Conectar motor|motor local|iniciador Windows/i);
  assert.doesNotMatch(app, /targetAddressSpace/);
  assert.match(app, /fetch\(apiUrl\(url\)/);

  const server = fs.readFileSync('src/server.js', 'utf8');
  assert.match(server, /listen\(port, '0\.0\.0\.0'/);
  assert.doesNotMatch(server, /127\.0\.0\.1|WA_OPEN_BROWSER|cmd\.exe|spawn\(|desenvolvimento local/i);
});
