// Authenticate CRM operators against the same Supabase project and membership
// check used by INFINITUM. The browser-supplied publishable key is public; the
// user access token is verified by Supabase Auth and RLS limits the membership read.
const uuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

export async function authorizeProjectW1SC(req, {
  requestFetch = fetch,
  env = process.env,
} = {}) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const jwt = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const key = String(req?.headers?.['x-wa-crm-publishable-key'] || '').trim();

  if (!url || !jwt || jwt.length > 6000 || !key || key.length > 1400 || /\s/.test(key)) {
    return null;
  }

  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + jwt,
    Accept: 'application/json',
  };
  const getUser = await requestFetch(url + '/auth/v1/user', {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(6500),
    redirect: 'error',
  });
  if (!getUser.ok) return null;

  const user = await getUser.json().catch(() => null);
  if (!uuid(user?.id)) return null;

  // INFINITUM currently uses the shared Lexis database. Mirror
  // checkLexisCompanyAccess() exactly: one usuarios row with company and name.
  if (String(env.NEXT_PUBLIC_LEXIS_SHARED_DB || '') === '1') {
    const query = new URLSearchParams({
      auth_user_id: 'eq.' + user.id,
      select: 'auth_user_id,empresa_id,nome',
      limit: '2',
    });
    const permission = await requestFetch(url + '/rest/v1/usuarios?' + query, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(6500),
      redirect: 'error',
    });
    if (!permission.ok) return null;

    const rows = await permission.json().catch(() => null);
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const membership = rows[0];
    if (
      membership?.auth_user_id !== user.id ||
      !membership?.empresa_id ||
      !String(membership?.nome || '').trim()
    ) {
      return null;
    }

    return {
      ok: true,
      userId: user.id,
      empresaId: membership.empresa_id,
      role: 'ProjectW1SC',
      canManage: false,
    };
  }

  // Retain the legacy access RPC for deployments that do not share the Lexis DB.
  const permission = await requestFetch(url + '/rest/v1/rpc/office_has_access', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(6500),
    redirect: 'error',
  });
  if (!permission.ok) return null;

  const allowed = await permission.json().catch(() => false);
  if (allowed !== true) return null;

  return {
    ok: true,
    userId: user.id,
    empresaId: null,
    role: 'ProjectW1SC',
    canManage: false,
  };
}
