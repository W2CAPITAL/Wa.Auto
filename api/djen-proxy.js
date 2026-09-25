const DJEN = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';

const digitsOnly = value => String(value || '').replace(/\D/g, '');
const maskCnj = digits => `${digits.slice(0,7)}-${digits.slice(7,9)}.${digits.slice(9,13)}.${digits.slice(13,14)}.${digits.slice(14,16)}.${digits.slice(16,20)}`;

async function queryOnce(cnj, start, end, page) {
  const params = new URLSearchParams({
    numeroProcesso: cnj,
    dataDisponibilizacaoInicio: start,
    dataDisponibilizacaoFim: end,
    pagina: String(page),
    itensPorPagina: '50'
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const response = await fetch(`${DJEN}?${params}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        Origin: 'https://comunica.pje.jus.br',
        Referer: 'https://comunica.pje.jus.br/'
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) return { ok:false, status:response.status, error:text.slice(0,500), items:[], count:0 };
    const data = JSON.parse(text);
    return { ok:true, status:response.status, items:Array.isArray(data?.items) ? data.items : [], count:Number(data?.count || 0) };
  } catch (error) {
    return { ok:false, status:0, error:error?.name === 'AbortError' ? 'timeout' : String(error?.message || error), items:[], count:0 };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });
  const digits = digitsOnly(req.body?.cnj);
  if (digits.length !== 20) return res.status(400).json({ ok:false, error:'CNJ inválido' });

  const now = new Date();
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.end || '')) ? String(req.body.end) : now.toISOString().slice(0,10);
  const fallbackStart = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0,10);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.start || '')) ? String(req.body.start) : fallbackStart;

  let lastError = null;
  for (const cnj of [digits, maskCnj(digits)]) {
    const first = await queryOnce(cnj, start, end, 1);
    if (!first.ok) { lastError = first; continue; }
    const items = [...first.items];
    const pages = Math.min(20, Math.max(1, Math.ceil(first.count / 50)));
    for (let page = 2; page <= pages; page++) {
      const next = await queryOnce(cnj, start, end, page);
      if (!next.ok) { lastError = next; break; }
      items.push(...next.items);
      if (!next.items.length) break;
    }
    if (items.length || first.count === 0) {
      return res.status(200).json({ ok:true, region:process.env.VERCEL_REGION || null, count:first.count || items.length, items });
    }
  }
  return res.status(lastError?.status || 502).json({ ok:false, region:process.env.VERCEL_REGION || null, error:lastError?.error || 'DJEN indisponível', items:[] });
}
