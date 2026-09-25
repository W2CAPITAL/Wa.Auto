import { createHash } from 'node:crypto';

const DATAJUD_BASE = 'https://api-publica.datajud.cnj.jus.br';
const DATAJUD_PUBLIC_KEY = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const DJEN_URL = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';

const COURT_ALIASES = {
  '8.01':'tjac','8.02':'tjal','8.03':'tjap','8.04':'tjam','8.05':'tjba','8.06':'tjce','8.07':'tjdft','8.08':'tjes','8.09':'tjgo','8.10':'tjma',
  '8.11':'tjmt','8.12':'tjms','8.13':'tjmg','8.14':'tjpa','8.15':'tjpb','8.16':'tjpr','8.17':'tjpe','8.18':'tjpi','8.19':'tjrj','8.20':'tjrn',
  '8.21':'tjrs','8.22':'tjro','8.23':'tjrr','8.24':'tjsc','8.25':'tjse','8.26':'tjsp','8.27':'tjto',
  '4.01':'trf1','4.02':'trf2','4.03':'trf3','4.04':'trf4','4.05':'trf5','4.06':'trf6',
  '5.01':'trt1','5.02':'trt2','5.03':'trt3','5.04':'trt4','5.05':'trt5','5.06':'trt6','5.07':'trt7','5.08':'trt8','5.09':'trt9','5.10':'trt10',
  '5.11':'trt11','5.12':'trt12','5.13':'trt13','5.14':'trt14','5.15':'trt15','5.16':'trt16','5.17':'trt17','5.18':'trt18','5.19':'trt19','5.20':'trt20',
  '5.21':'trt21','5.22':'trt22','5.23':'trt23','5.24':'trt24',
  '2.00':'stj','2.01':'stj','3.00':'tst','3.01':'tst','6.00':'tse','7.00':'stm'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plainText = value => String(value || '')
  .replace(/<br\s*\/?>/gi,'\n')
  .replace(/<\/(?:p|div|li|tr)>/gi,'\n')
  .replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;/g,' ')
  .replace(/&amp;/g,'&')
  .replace(/&lt;/g,'<')
  .replace(/&gt;/g,'>')
  .replace(/&quot;/g,'"')
  .replace(/&#39;/g,"'")
  .replace(/[ \t]+/g,' ')
  .trim();

export function normalizeCnj(value) {
  const digits = String(value || '').replace(/\D/g,'');
  if (digits.length !== 20) return null;
  return digits;
}
export function formatCnj(value) {
  const d = normalizeCnj(value);
  if (!d) return String(value || '');
  return `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`;
}
export function resolveDataJudAlias(value) {
  const d = normalizeCnj(value);
  if (!d) return '';
  const key = `${d[13]}.${d.slice(14,16)}`;
  if (COURT_ALIASES[key]) return COURT_ALIASES[key];
  if (d[13] === '5') return `trt${Number(d.slice(14,16))}`;
  if (d[13] === '2') return 'stj';
  if (d[13] === '3') return 'tst';
  if (d[13] === '6') return 'tse';
  if (d[13] === '7') return 'stm';
  return '';
}
function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
function eventTime(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}
function summarizeMovement(movement) {
  const title = String(movement?.nome || movement?.descricao || movement?.complemento || 'Movimentação processual').trim();
  const details = String(movement?.complemento || movement?.descricao || '').trim();
  return { title: title.slice(0,500), details: details.slice(0,4000) };
}
function parseDjenItems(data) {
  const raw = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.content) ? data.content : [];
  return raw.filter(Boolean).map(item => ({
    ...item,
    texto: plainText(item.texto || '')
  }));
}

export async function fetchDataJudProcess(cnj, { fetchImpl = fetch, apiKey = process.env.DATAJUD_API_KEY || DATAJUD_PUBLIC_KEY } = {}) {
  const digits = normalizeCnj(cnj);
  if (!digits) return { ok:false, source:'DataJud', error:'Número CNJ inválido.', events:[] };
  const alias = resolveDataJudAlias(digits);
  if (!alias) return { ok:false, source:'DataJud', error:'Tribunal não identificado pelo número CNJ.', events:[] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(`${DATAJUD_BASE}/api_publica_${alias}/_search`, {
      method:'POST',
      headers:{ Authorization:`APIKey ${apiKey}`, 'Content-Type':'application/json', Accept:'application/json' },
      body:JSON.stringify({
        size:1,
        query:{ bool:{ should:[{ match:{ numeroProcesso:digits } },{ match:{ numeroProcesso:formatCnj(digits) } }], minimum_should_match:1 } }
      }),
      signal:controller.signal
    });
    if (!response.ok) return { ok:false, source:'DataJud', alias, status:response.status, error:`DataJud respondeu HTTP ${response.status}.`, events:[] };
    const data = await response.json();
    const source = data?.hits?.hits?.[0]?._source;
    if (!source) return { ok:true, source:'DataJud', alias, found:false, events:[] };
    const movements = Array.isArray(source.movimentos) ? source.movimentos : [];
    const events = movements.map(movement => {
      const { title, details } = summarizeMovement(movement);
      const at = eventTime(movement?.dataHora || movement?.data || source?.dataHoraUltimaAtualizacao);
      return {
        source:'DataJud',
        eventAt:at,
        title,
        details,
        hash:sha(`DataJud|${digits}|${at}|${title}|${details}`)
      };
    }).sort((a,b) => b.eventAt.localeCompare(a.eventAt));
    return {
      ok:true, source:'DataJud', alias, found:true,
      tribunal:source.tribunal || alias.toUpperCase(),
      classe:source.classe?.nome || source.classe?.codigo || '',
      events
    };
  } catch (error) {
    return { ok:false, source:'DataJud', alias, error:error?.name === 'AbortError' ? 'Tempo esgotado ao consultar o DataJud.' : 'Falha de rede ao consultar o DataJud.', events:[] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchDjenProcess(cnj, { fetchImpl = fetch, days = 120 } = {}) {
  const digits = normalizeCnj(cnj);
  if (!digits) return { ok:false, source:'DJEN', error:'Número CNJ inválido.', events:[] };
  const end = new Date();
  const start = new Date(Date.now() - Math.max(1, Math.min(Number(days) || 120, 365)) * 86400000);
  const params = new URLSearchParams({
    numeroProcesso:digits,
    dataDisponibilizacaoInicio:start.toISOString().slice(0,10),
    dataDisponibilizacaoFim:end.toISOString().slice(0,10),
    pagina:'1',
    itensPorPagina:'100'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);
  try {
    const response = await fetchImpl(`${DJEN_URL}?${params}`, { headers:{ Accept:'application/json' }, signal:controller.signal });
    if (response.status === 403) return { ok:false, source:'DJEN', blocked:true, status:403, error:'DJEN recusou temporariamente a rede do servidor (403).', events:[] };
    if (response.status === 429) return { ok:false, source:'DJEN', rateLimited:true, status:429, error:'DJEN pediu pausa por excesso de consultas (429).', events:[] };
    const raw = await response.text();
    const trimmed = raw.trim();
    if (!response.ok || !trimmed || trimmed.startsWith('<')) return { ok:false, source:'DJEN', status:response.status, error:`DJEN indisponível (HTTP ${response.status}).`, events:[] };
    let data;
    try { data = JSON.parse(trimmed); }
    catch { return { ok:false, source:'DJEN', error:'DJEN retornou uma resposta inválida.', events:[] }; }
    const items = parseDjenItems(data);
    const events = items.map(item => {
      const at = eventTime(item.data_disponibilizacao || item.dataDisponibilizacao || item.data);
      const title = String(item.tipoComunicacao || item.nomeClasse || 'Publicação DJEN').trim().slice(0,500);
      const details = plainText(item.texto || '').slice(0,4000);
      const identifier = item.hash || item.id || '';
      return {
        source:'DJEN',
        eventAt:at,
        title,
        details,
        link: item.link || (item.hash ? `https://comunica.pje.jus.br/consulta?hash=${encodeURIComponent(item.hash)}` : ''),
        hash:sha(`DJEN|${digits}|${identifier}|${at}|${title}|${details}`)
      };
    }).sort((a,b) => b.eventAt.localeCompare(a.eventAt));
    return { ok:true, source:'DJEN', events };
  } catch (error) {
    return { ok:false, source:'DJEN', error:error?.name === 'AbortError' ? 'Tempo esgotado ao consultar o DJEN.' : 'Falha de rede ao consultar o DJEN.', events:[] };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatProcessMessage(monitor, event) {
  const when = new Date(event.eventAt);
  const date = Number.isFinite(when.getTime())
    ? when.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' })
    : event.eventAt;
  const details = event.details && event.details !== event.title ? `\n\nDetalhe: ${event.details.slice(0,1200)}` : '';
  return [
    '📌 *ATUALIZAÇÃO PROCESSUAL*',
    monitor.client_name ? `\nCliente: *${monitor.client_name}*` : '',
    `\nProcesso: *${formatCnj(monitor.cnj)}*`,
    `\nFonte: *${event.source}*`,
    `\nNova movimentação: ${event.title}`,
    details,
    `\nData/Hora: ${date}`,
    '\n\nMensagem automática de acompanhamento. Responda SAIR se não quiser receber novos avisos.'
  ].join('');
}

export class LegalMonitorService {
  constructor(store, transport, {
    fetchImpl = fetch,
    onMutation = () => {},
    scanIntervalMs = 30 * 60 * 1000,
    minTriggerIntervalMs = 20 * 60 * 1000,
    sendDelayMs = 5000
  } = {}) {
    this.store = store;
    this.transport = transport;
    this.fetchImpl = fetchImpl;
    this.onMutation = onMutation;
    this.scanIntervalMs = scanIntervalMs;
    this.minTriggerIntervalMs = minTriggerIntervalMs;
    this.sendDelayMs = Math.max(0, Number(sendDelayMs) || 0);
    this.busy = false;
    this.timer = null;
  }

  snapshot() {
    return { ...this.store.legalStats(), busy:this.busy };
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.scanAll().catch(error => console.error('Monitor jurídico:', error.message)), this.scanIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async trigger({ force = false } = {}) {
    const last = Number(this.store.getMeta('legalLastTriggeredAt') || 0);
    const now = Date.now();
    if (!force && last && now - last < this.minTriggerIntervalMs) {
      return { skipped:true, reason:'cooldown', nextInMs:this.minTriggerIntervalMs - (now - last), ...this.snapshot() };
    }
    this.store.setMeta('legalLastTriggeredAt', String(now));
    return this.scanAll();
  }

  async scanAll() {
    if (this.busy) return { skipped:true, reason:'busy', ...this.snapshot() };
    this.busy = true;
    const result = { checked:0, newEvents:0, sent:0, failed:0, sources:{ DataJud:{ok:0,error:0}, DJEN:{ok:0,error:0} } };
    try {
      const monitors = this.store.legalMonitors().filter(item => item.enabled);
      for (const monitor of monitors) {
        const one = await this.scanOne(monitor);
        result.checked++;
        result.newEvents += one.newEvents;
        result.sent += one.sent;
        result.failed += one.failed;
        for (const [source, status] of Object.entries(one.sources)) result.sources[source][status ? 'ok' : 'error']++;
        await sleep(450);
      }
      this.store.setMeta('legalLastScanAt', new Date().toISOString());
      this.onMutation();
      return { ...result, ...this.snapshot() };
    } finally {
      this.busy = false;
    }
  }

  async scanOne(monitorOrId, { seedOnly = false } = {}) {
    const monitor = typeof monitorOrId === 'string' ? this.store.legalMonitor(monitorOrId) : monitorOrId;
    const sources = {};
    const fetched = [];
    if (monitor.mode === 'datajud' || monitor.mode === 'both') {
      const datajud = await fetchDataJudProcess(monitor.cnj, { fetchImpl:this.fetchImpl });
      sources.DataJud = datajud.ok;
      if (datajud.ok) fetched.push(...datajud.events);
    }
    if (monitor.mode === 'djen' || monitor.mode === 'both') {
      const djen = await fetchDjenProcess(monitor.cnj, { fetchImpl:this.fetchImpl });
      sources.DJEN = djen.ok;
      if (djen.ok) fetched.push(...djen.events);
    }

    const errors = [];
    if (sources.DataJud === false) errors.push('DataJud indisponível nesta consulta');
    if (sources.DJEN === false) errors.push('DJEN indisponível nesta consulta');
    const sorted = fetched
      .sort((a,b) => a.eventAt.localeCompare(b.eventAt))
      .slice(-120);
    const baseline = !monitor.last_event_at;
    let newEvents = 0;
    for (const event of sorted) {
      if (this.store.hasLegalEvent(monitor.id, event.hash)) continue;
      if (baseline || seedOnly) {
        this.store.recordLegalEvent({ monitorId:monitor.id, eventHash:event.hash, source:event.source, title:event.title, details:event.details || '', eventAt:event.eventAt, sendStatus:'baseline' });
        continue;
      }
      // Depois da linha de base, a identidade do evento (hash) é a fonte de verdade.
      // Isso também captura movimentações que o tribunal publica com atraso e cuja
      // data oficial pode ser anterior ao último check.
      this.store.recordLegalEvent({ monitorId:monitor.id, eventHash:event.hash, source:event.source, title:event.title, details:event.details || '', eventAt:event.eventAt, sendStatus:'waiting' });
      newEvents++;
    }

    const latest = fetched.sort((a,b) => b.eventAt.localeCompare(a.eventAt))[0];
    this.store.updateLegalMonitor(monitor.id, {
      tribunal_alias: monitor.tribunal_alias || resolveDataJudAlias(monitor.cnj),
      last_checked_at:new Date().toISOString(),
      ...(latest ? {
        last_event_at: latest.eventAt,
        last_event_hash: latest.hash,
        last_event_source: latest.source,
        last_event_text: latest.title
      } : {}),
      error:errors.join(' · ')
    });
    this.onMutation();

    const sentResult = await this.sendPendingNotifications();
    return { newEvents, sent:sentResult.sent, failed:sentResult.failed, sources };
  }

  async sendPendingNotifications() {
    if (this.store.active()) return { sent:0, failed:0, waiting:this.store.pendingLegalEvents(100).length };
    if (!this.transport.isReady()) return { sent:0, failed:0, waiting:this.store.pendingLegalEvents(100).length };
    let sent = 0, failed = 0;
    for (const event of this.store.pendingLegalEvents(25)) {
      try {
        if (this.store.isBlocked(event.phone, `${event.phone}@s.whatsapp.net`, `${event.phone}@c.us`)) {
          this.store.markLegalEvent(event.id, { sendStatus:'blocked', error:'Contato está na lista de não contatar.' });
          continue;
        }
        const jid = await this.transport.resolve(event.phone);
        if (!jid) {
          this.store.markLegalEvent(event.id, { sendStatus:'failed', error:'Número não encontrado no WhatsApp.' });
          failed++;
          continue;
        }
        const monitor = { cnj:event.cnj, client_name:event.client_name, phone:event.phone };
        const result = await this.transport.send(jid, formatProcessMessage(monitor, event));
        this.store.markLegalEvent(event.id, { sendStatus:'sent', messageId:result?.id || null });
        sent++;
        this.onMutation();
        if (this.sendDelayMs) await sleep(this.sendDelayMs);
      } catch (error) {
        this.store.markLegalEvent(event.id, { sendStatus:'failed', error:String(error?.message || 'Falha no envio').slice(0,500) });
        failed++;
      }
    }
    return { sent, failed, waiting:this.store.pendingLegalEvents(100).length };
  }
}
