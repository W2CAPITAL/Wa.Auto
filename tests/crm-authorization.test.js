import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeProjectW1SC } from '../src/crm-authorization.js';

const user = '550e8400-e29b-41d4-a716-446655440000';
const company = '7a7b4a4a-2b2b-4c2c-8f2d-4f5a6d7b8c9d';
const baseUrl = 'https://crm-project.supabase.co';
const publishableKey = 'sb_publishable_for_tests';
const req = {
  headers: {
    authorization: 'Bearer valid-client-token',
    'x-wa-crm-publishable-key': publishableKey,
    'x-lexis-user-id': 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  },
};
const sharedEnv = { SUPABASE_URL: baseUrl + '/', NEXT_PUBLIC_LEXIS_SHARED_DB: '1' };
const response = (ok, body) => ({ ok, json: async () => body });

test('no JWT, publishable key or Supabase URL cannot access a WhatsApp session', async () => {
  const probe = async () => { throw Error('must not call network'); };
  assert.equal(await authorizeProjectW1SC({ headers: {} }, { requestFetch: probe, env: sharedEnv }), null);
  assert.equal(await authorizeProjectW1SC(req, { requestFetch: probe, env: { ...sharedEnv, SUPABASE_URL: '' } }), null);
  assert.equal(await authorizeProjectW1SC({ headers: { authorization: req.headers.authorization } }, { requestFetch: probe, env: sharedEnv }), null);
});

test('JWT must be verified by the configured Supabase Auth before checking office access', async () => {
  const bad = await authorizeProjectW1SC(req, {
    env: sharedEnv,
    requestFetch: async () => response(false, null),
  });
  assert.equal(bad, null);

  const denied = await authorizeProjectW1SC(req, {
    env: sharedEnv,
    requestFetch: async url => url.endsWith('/auth/v1/user')
      ? response(true, { id: user })
      : response(true, []),
  });
  assert.equal(denied, null);
});

test('shared Lexis database checks the verified user in usuarios and ignores spoofed user headers', async () => {
  const visited = [];
  const accepted = await authorizeProjectW1SC(req, {
    env: sharedEnv,
    requestFetch: async (url, init) => {
      visited.push({ url, init });
      assert.equal(new URL(url).origin, baseUrl);
      assert.ok(init.headers.Authorization.startsWith('Bearer '));
      assert.equal(init.headers.apikey, publishableKey);
      if (url.endsWith('/auth/v1/user')) return response(true, { id: user });
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/rest/v1/usuarios');
      assert.equal(parsed.searchParams.get('auth_user_id'), 'eq.' + user);
      assert.equal(parsed.searchParams.get('select'), 'auth_user_id,empresa_id,nome');
      assert.equal(parsed.searchParams.get('limit'), '2');
      assert.equal(init.method, 'GET');
      return response(true, [{ auth_user_id: user, empresa_id: company, nome: 'Operador' }]);
    },
  });

  assert.equal(accepted.userId, user);
  assert.equal(accepted.empresaId, company);
  assert.notEqual(accepted.userId, req.headers['x-lexis-user-id']);
  assert.equal(visited.length, 2);
});

test('shared Lexis database rejects missing, duplicate or incomplete company memberships', async () => {
  for (const rows of [
    [],
    [{ auth_user_id: user, empresa_id: company, nome: '' }],
    [{ auth_user_id: user, empresa_id: null, nome: 'Operador' }],
    [
      { auth_user_id: user, empresa_id: company, nome: 'Operador' },
      { auth_user_id: user, empresa_id: company, nome: 'Duplicado' },
    ],
  ]) {
    const denied = await authorizeProjectW1SC(req, {
      env: sharedEnv,
      requestFetch: async url => url.endsWith('/auth/v1/user')
        ? response(true, { id: user })
        : response(true, rows),
    });
    assert.equal(denied, null);
  }
});

test('legacy mode continues to require the office_has_access RPC', async () => {
  const visited = [];
  const accepted = await authorizeProjectW1SC(req, {
    env: { SUPABASE_URL: baseUrl, NEXT_PUBLIC_LEXIS_SHARED_DB: '0' },
    requestFetch: async (url, init) => {
      visited.push({ url, init });
      if (url.endsWith('/auth/v1/user')) return response(true, { id: user });
      assert.equal(url, baseUrl + '/rest/v1/rpc/office_has_access');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{}');
      return response(true, true);
    },
  });
  assert.equal(accepted.userId, user);
  assert.equal(visited.length, 2);
});
