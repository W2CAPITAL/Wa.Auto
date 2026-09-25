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

export function parseClientDate(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const date = new Date(value.getTime());
    if (endOfDay) date.setUTCHours(23, 59, 59, 999);
    return date.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;

  // Excel serial date persisted as text.
  if (/^\d{5}(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial > 20000 && serial < 90000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (endOfDay) date.setUTCHours(23, 59, 59, 999);
      return date.toISOString();
    }
  }

  const br = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (br) {
    const [, dd, mm, yyyy, hh, mi, ss] = br;
    const hasTime = hh != null;
    const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hasTime ? Number(hh) : (endOfDay ? 23 : 0), hasTime ? Number(mi) : (endOfDay ? 59 : 0), hasTime ? Number(ss || 0) : (endOfDay ? 59 : 0), endOfDay && !hasTime ? 999 : 0));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
}

function latestBoundary(...values) {
  return values.filter(Boolean).sort().at(-1) || null;
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

export function formatCurrentProcessReturn(cnj, event) {
  const when = new Date(event.eventAt || event.event_at);
  const date = Number.isFinite(when.getTime())
    ? when.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' })
    : (event.eventAt || event.event_at || '—');
  const details = event.details && event.details !== event.title
    ? `\n\nDetalhe: ${String(event.details).slice(0,1200)}`
    : '';
  return [
    '📌 *RETORNO PROCESSUAL*',
    `\nProcesso: *${formatCnj(cnj)}*`,
    `\nFonte: *${event.source}*`,
    `\nMovimentação mais recente localizada: ${event.title}`,
    details,
    `\nData/Hora: ${date}`,
    '\n\nSeguimos acompanhando as próximas movimentações do processo.',
    '\nEsta mensagem é informativa e reproduz o andamento público localizado no tribunal.',
    '\n\nResponda SAIR se não quiser receber novos avisos.'
  ].join('').slice(0,7600);
}

export function formatProcessDigest(monitor, events) {
  const ordered = [...events].sort((a,b) => String(a.event_at || a.eventAt).localeCompare(String(b.event_at || b.eventAt)));
  if (ordered.length === 1) {
    const event = ordered[0];
    return formatProcessMessage(monitor, { ...event, eventAt:event.eventAt || event.event_at });
  }
  const lines = ordered.slice(-12).map(event => {
    const rawDate = event.eventAt || event.event_at;
    const date = new Date(rawDate);
    const when = Number.isFinite(date.getTime())
      ? date.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' })
      : rawDate;
    return `• [${event.source}] ${when} — ${String(event.title || 'Movimentação processual').slice(0,420)}`;
  });
  const omitted = Math.max(0, ordered.length - lines.length);
  return [
    '📌 *ATUALIZAÇÃO PROCESSUAL*',
    monitor.client_name ? `\nCliente: *${monitor.client_name}*` : '',
    `\nProcesso: *${formatCnj(monitor.cnj)}*`,
    `\nForam detectadas *${ordered.length} novas movimentações* desde o último aviso:\n`,
    lines.join('\n'),
    omitted ? `\n+ ${omitted} movimentação(ões) adicional(is) registrada(s) no histórico do WA.Auto.` : '',
    '\n\nMensagem automática de acompanhamento. Responda SAIR se não quiser receber novos avisos.'
  ].join('').slice(0,7600);
}

export class LegalMonitorService {
  constructor(store, transport, {
    fetchImpl = fetch,
    onMutation = () => {},
    scanIntervalMs = 30 * 60 * 1000,
    minTriggerIntervalMs = 20 * 60 * 1000,
    sendDelayMs = 30000,
    resourceGuard = null,
    criticalIntent = null
  } = {}) {
    this.store = store;
    this.transport = transport;
    this.fetchImpl = fetchImpl;
    this.onMutation = onMutation;
    this.scanIntervalMs = scanIntervalMs;
    this.minTriggerIntervalMs = minTriggerIntervalMs;
    this.sendDelayMs = Math.max(0, Number(sendDelayMs) || 0);
    this.resourceGuard = resourceGuard;
    this.criticalIntent = criticalIntent;
    this.busy = false;
    this.timer = null;
    this.sendTimer = null;
  }

  snapshot() {
    return { ...this.store.legalStats(), busy:this.busy };
  }

  start() {
    clearInterval(this.timer);
    clearInterval(this.sendTimer);
    this.timer = setInterval(() => void this.trigger({ force:true }).catch(error => console.error('Monitor jurídico:', error.message)), this.scanIntervalMs);
    this.timer.unref?.();
    const drainEvery = Math.max(5000, this.sendDelayMs || 5000);
    this.sendTimer = setInterval(() => void this.sendPendingNotifications({ maxGroups:1 }).catch(error => console.error('Fila jurídica:', error.message)), drainEvery);
    this.sendTimer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.sendTimer);
    this.timer = null;
    this.sendTimer = null;
  }

  async trigger({ force = false } = {}) {
    if (this.resourceGuard && !this.resourceGuard.canWork()) {
      return { skipped:true, reason:'memory-pressure', ...this.snapshot() };
    }
    const last = Number(this.store.getMeta('legalLastTriggeredAt') || 0);
    const now = Date.now();
    if (!force && last && now - last < this.minTriggerIntervalMs) {
      return { skipped:true, reason:'cooldown', nextInMs:this.minTriggerIntervalMs - (now - last), ...this.snapshot() };
    }
    this.store.setMeta('legalLastTriggeredAt', String(now));
    return this.scanAll({ limit:20, useCursor:true });
  }

  async scanAll({ limit = 20, useCursor = true } = {}) {
    if (this.busy) return { skipped:true, reason:'busy', ...this.snapshot() };
    this.busy = true;
    const result = { checked:0, total:0, cursor:0, newEvents:0, sent:0, failed:0, sources:{ DataJud:{ok:0,error:0}, DJEN:{ok:0,error:0} } };
    try {
      const monitors = this.store.legalMonitors().filter(item => item.enabled);
      result.total = monitors.length;
      let selected = monitors;
      if (useCursor && limit && monitors.length > limit) {
        const current = Math.max(0, Number(this.store.getMeta('legalScanCursor') || 0)) % monitors.length;
        selected = [];
        for (let index = 0; index < Math.min(limit, monitors.length); index++) selected.push(monitors[(current + index) % monitors.length]);
        const next = (current + selected.length) % monitors.length;
        this.store.setMeta('legalScanCursor', String(next));
        result.cursor = next;
      } else {
        result.cursor = 0;
        this.store.setMeta('legalScanCursor', '0');
      }

      for (const monitor of selected) {
        if (this.resourceGuard && !this.resourceGuard.canWork()) {
          result.stoppedForMemory = true;
          break;
        }
        const one = await this.scanOne(monitor);
        result.checked++;
        result.newEvents += one.newEvents;
        result.sent += one.sent;
        result.failed += one.failed;
        for (const [source, status] of Object.entries(one.sources)) result.sources[source][status ? 'ok' : 'error']++;
        await sleep(300);
      }
      this.store.setMeta('legalLastScanAt', new Date().toISOString());
      this.onMutation();
      return { ...result, ...this.snapshot() };
    } finally {
      this.busy = false;
    }
  }

  syncSpreadsheetSnapshot(monitorOrId, snapshot = {}) {
    let monitor = typeof monitorOrId === 'string' ? this.store.legalMonitor(monitorOrId) : monitorOrId;
    const lastReturnAt = parseClientDate(snapshot.lastReturnAt, { endOfDay:true });
    const nextReturnAt = parseClientDate(snapshot.nextReturnAt, { endOfDay:true });
    const sheetMovementAt = parseClientDate(snapshot.movementAt);
    const djenAt = parseClientDate(snapshot.djenAt);
    const lastNotifiedAt = parseClientDate(snapshot.lastNotifiedAt);

    this.store.updateLegalMonitor(monitor.id, {
      ...(nextReturnAt ? { next_return_at:nextReturnAt } : {}),
      ...(sheetMovementAt ? { sheet_movement_at:sheetMovementAt } : {}),
      ...(snapshot.movementText ? { sheet_movement_text:String(snapshot.movementText).slice(0,4000) } : {}),
      ...(lastNotifiedAt ? { last_notified_at:lastNotifiedAt } : {}),
      ...(snapshot.sourceImportId ? { source_import_id:snapshot.sourceImportId } : {}),
      ...(snapshot.sourceSheet ? { source_sheet:snapshot.sourceSheet } : {}),
      ...(snapshot.sourceRow != null ? { source_row:Number(snapshot.sourceRow) } : {})
    });
    if (lastReturnAt) this.store.setLegalReturn({ phone:monitor.phone, cnj:monitor.cnj, at:lastReturnAt, source:'planilha importada' });
    monitor = this.store.legalMonitor(monitor.id);

    const candidates = [];
    if (sheetMovementAt && snapshot.movementText) {
      const title = String(snapshot.movementText).trim().slice(0,500) || 'Movimentação processual';
      candidates.push({
        source:'Planilha/DataJud',
        eventAt:sheetMovementAt,
        title,
        details:String(snapshot.movementDetails || '').trim().slice(0,4000),
        hash:sha(`Planilha/DataJud|${monitor.cnj}|${sheetMovementAt}|${title}`)
      });
    }
    if (djenAt && snapshot.djenText) {
      const title = String(snapshot.djenText).trim().slice(0,500) || 'Publicação DJEN';
      candidates.push({
        source:'Planilha/DJEN',
        eventAt:djenAt,
        title,
        details:'',
        hash:sha(`Planilha/DJEN|${monitor.cnj}|${djenAt}|${title}`)
      });
    }

    let queued = 0, baseline = 0, covered = 0;
    const boundary = latestBoundary(monitor.last_return_at, monitor.last_notified_at);
    for (const event of candidates.sort((a,b) => a.eventAt.localeCompare(b.eventAt))) {
      if (this.store.hasLegalEvent(monitor.id, event.hash) || this.store.hasEquivalentLegalEvent(monitor.id, event.eventAt, event.title)) continue;
      let sendStatus = 'baseline';
      if (boundary) sendStatus = event.eventAt > boundary ? 'waiting' : 'covered_by_return';
      const saved = this.store.recordLegalEvent({
        monitorId:monitor.id, eventHash:event.hash, source:event.source, title:event.title,
        details:event.details, eventAt:event.eventAt, sendStatus
      });
      if (saved?.send_status === 'waiting') queued++;
      else if (saved?.send_status === 'covered_by_return') covered++;
      else baseline++;
    }

    const latest = candidates.sort((a,b) => b.eventAt.localeCompare(a.eventAt))[0];
    if (latest && (!monitor.last_event_at || latest.eventAt > monitor.last_event_at)) {
      this.store.updateLegalMonitor(monitor.id, {
        last_event_at:latest.eventAt,
        last_event_hash:latest.hash,
        last_event_source:latest.source,
        last_event_text:latest.title
      });
    }
    this.onMutation();
    return { queued, baseline, covered, boundary:lastReturnAt || monitor.last_return_at || null };
  }

  async scanOne(monitorOrId, { seedOnly = false } = {}) {
    const monitor = typeof monitorOrId === 'string' ? this.store.legalMonitor(monitorOrId) : monitorOrId;
    const sources = {};
    const fetched = [];
    const jobs = [];
    if (monitor.mode === 'datajud' || monitor.mode === 'both') {
      jobs.push(fetchDataJudProcess(monitor.cnj, { fetchImpl:this.fetchImpl }).then(result => ['DataJud', result]));
    }
    if (monitor.mode === 'djen' || monitor.mode === 'both') {
      jobs.push(fetchDjenProcess(monitor.cnj, { fetchImpl:this.fetchImpl }).then(result => ['DJEN', result]));
    }
    for (const [sourceName, result] of await Promise.all(jobs)) {
      sources[sourceName] = result.ok;
      if (result.ok) fetched.push(...result.events);
    }

    const errors = [];
    if (sources.DataJud === false) errors.push('DataJud indisponível nesta consulta');
    if (sources.DJEN === false) errors.push('DJEN indisponível nesta consulta');
    const sorted = fetched
      .sort((a,b) => a.eventAt.localeCompare(b.eventAt))
      .slice(-120);
    const baseline = !monitor.last_event_at;
    const boundary = latestBoundary(monitor.last_return_at, monitor.last_notified_at);
    let newEvents = 0;
    for (const event of sorted) {
      if (this.store.hasLegalEvent(monitor.id, event.hash) || this.store.hasEquivalentLegalEvent(monitor.id, event.eventAt, event.title)) continue;
      let sendStatus;
      if (boundary) {
        sendStatus = event.eventAt > boundary ? 'waiting' : 'covered_by_return';
      } else if (baseline || seedOnly) {
        sendStatus = 'baseline';
      } else {
        sendStatus = 'waiting';
      }
      this.store.recordLegalEvent({ monitorId:monitor.id, eventHash:event.hash, source:event.source, title:event.title, details:event.details || '', eventAt:event.eventAt, sendStatus });
      if (sendStatus === 'waiting') newEvents++;
    }

    const latest = fetched.sort((a,b) => b.eventAt.localeCompare(a.eventAt))[0];
    const shouldAdvanceLatest = latest && (!monitor.last_event_at || latest.eventAt > monitor.last_event_at);
    this.store.updateLegalMonitor(monitor.id, {
      tribunal_alias: monitor.tribunal_alias || resolveDataJudAlias(monitor.cnj),
      last_checked_at:new Date().toISOString(),
      ...(shouldAdvanceLatest ? {
        last_event_at: latest.eventAt,
        last_event_hash: latest.hash,
        last_event_source: latest.source,
        last_event_text: latest.title
      } : {}),
      error:errors.join(' · ')
    });
    this.onMutation();

    const sentResult = await this.sendPendingNotifications({ maxGroups:1 });
    return { newEvents, sent:sentResult.sent, failed:sentResult.failed, sources };
  }

  async sendOneOffProcessReturn({ cnj, phone, requestId }) {
    const digits = normalizeCnj(cnj);
    if (!digits) throw new Error('Número CNJ inválido para o retorno.');
    if (!phone) throw new Error('Telefone não informado para o retorno.');
    if (!requestId) throw new Error('Identificador do retorno não informado.');

    const existingMonitor = this.store.legalMonitors().find(item => item.cnj === digits && item.phone === phone);
    const monitor = existingMonitor || this.store.createLegalMonitor({
      cnj:digits,
      clientName:'',
      phone,
      tribunalAlias:resolveDataJudAlias(digits),
      mode:'both',
      notifyWhatsapp:true
    });

    const [datajud, djen] = await Promise.all([
      fetchDataJudProcess(digits, { fetchImpl:this.fetchImpl }),
      fetchDjenProcess(digits, { fetchImpl:this.fetchImpl })
    ]);
    const candidates = [...(datajud.ok ? datajud.events : []), ...(djen.ok ? djen.events : [])]
      .filter(event => event?.eventAt && event.eventAt > '1971-01-01T00:00:00.000Z')
      .sort((a,b) => b.eventAt.localeCompare(a.eventAt));
    const latest = candidates[0];
    if (!latest) {
      const reasons = [datajud.error, djen.error].filter(Boolean).join(' · ');
      throw new Error(reasons || 'Nenhuma movimentação pública foi localizada para o processo.');
    }

    const eventHash = sha(`OneOff|${requestId}|${latest.hash}`);
    let event = this.store.recordLegalEvent({
      monitorId:monitor.id,
      eventHash,
      source:latest.source,
      title:latest.title,
      details:latest.details || '',
      eventAt:latest.eventAt,
      sendStatus:'waiting'
    });

    if (['sent','delivered','read','uncertain'].includes(event.send_status)) {
      return { status:event.send_status, alreadyProcessed:true, source:event.source, eventAt:event.event_at, title:event.title, messageId:event.message_id || null };
    }
    if (!this.transport.isReady()) throw new Error('WhatsApp não está conectado.');
    if (this.store.isBlocked(phone, `${phone}@s.whatsapp.net`, `${phone}@c.us`)) {
      this.store.markLegalEvent(event.id, { sendStatus:'blocked', error:'Contato está na lista de não contatar.' });
      this.onMutation();
      throw new Error('Contato está na lista de não contatar.');
    }

    const jid = await this.transport.resolve(phone);
    if (!jid) {
      this.store.markLegalEvent(event.id, { sendStatus:'failed', error:'Número não encontrado no WhatsApp.' });
      this.onMutation();
      throw new Error('Número não encontrado no WhatsApp.');
    }

    let attempted = false;
    try {
      if (this.criticalIntent) await this.criticalIntent.begin('legal', { monitorId:monitor.id, eventIds:[event.id], phone, jid, requestId });
      this.store.markLegalEvent(event.id, { sendStatus:'sending', error:'' });
      attempted = true;
      this.criticalIntent?.arm();
      this.onMutation();

      const result = await this.transport.send(jid, formatCurrentProcessReturn(digits, latest));
      this.store.markLegalEvent(event.id, { sendStatus:'sent', messageId:result?.id || null });
      const sentAt = new Date().toISOString();
      this.store.markLegalNotified(monitor.id, [event], sentAt);
      this.store.setMeta('oneOffReturn:' + requestId, JSON.stringify({
        cnj:digits, phone, eventHash, source:latest.source, eventAt:latest.eventAt,
        title:latest.title, sentAt, messageId:result?.id || null
      }));
      this.onMutation();
      return { status:'sent', source:latest.source, eventAt:latest.eventAt, title:latest.title, messageId:result?.id || null, datajudOk:datajud.ok, djenOk:djen.ok };
    } catch (error) {
      const message = String(error?.message || 'Falha no envio').slice(0,500);
      if (attempted) {
        this.store.markLegalEvent(event.id, { sendStatus:'uncertain', error:'Envio sem confirmação. Não haverá reenvio automático deste teste.' });
      } else {
        this.store.markLegalEvent(event.id, { sendStatus:'failed', error:message });
      }
      this.onMutation();
      throw error;
    }
  }

  async sendPendingNotifications({ maxGroups = 25 } = {}) {
    if (this.store.active()) return { sent:0, failed:0, waiting:this.store.pendingLegalEvents(100).length };
    if (!this.transport.isReady()) return { sent:0, failed:0, waiting:this.store.pendingLegalEvents(100).length };
    if (this.resourceGuard && !this.resourceGuard.canWork()) return { sent:0, failed:0, waiting:this.store.pendingLegalEvents(100).length, skipped:true, reason:'memory-pressure' };

    const pending = this.store.pendingLegalEvents(100);
    const groups = new Map();
    for (const event of pending) {
      const key = event.monitor_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }

    let sent = 0, failed = 0, processedGroups = 0;
    for (const events of groups.values()) {
      if (processedGroups >= Math.max(1, Number(maxGroups) || 1)) break;
      if (this.store.active() || !this.transport.isReady()) break;
      if (this.resourceGuard && !this.resourceGuard.canWork()) break;
      const first = events[0];
      let attempted = false;

      try {
        if (this.store.isBlocked(first.phone, `${first.phone}@s.whatsapp.net`, `${first.phone}@c.us`)) {
          for (const event of events) this.store.markLegalEvent(event.id, { sendStatus:'blocked', error:'Contato está na lista de não contatar.' });
          this.onMutation();
          continue;
        }

        const jid = await this.transport.resolve(first.phone);
        if (!jid) {
          for (const event of events) this.store.markLegalEvent(event.id, { sendStatus:'failed', error:'Número não encontrado no WhatsApp.' });
          failed += events.length;
          this.onMutation();
          continue;
        }

        if (this.criticalIntent) {
          await this.criticalIntent.begin('legal', { monitorId:first.monitor_id, eventIds:events.map(event => event.id), phone:first.phone, jid });
        }
        for (const event of events) this.store.markLegalEvent(event.id, { sendStatus:'sending', error:'' });
        attempted = true;
        this.criticalIntent?.arm();
        this.onMutation();

        const monitor = { cnj:first.cnj, client_name:first.client_name, phone:first.phone };
        const result = await this.transport.send(jid, formatProcessDigest(monitor, events));
        for (const event of events) this.store.markLegalEvent(event.id, { sendStatus:'sent', messageId:result?.id || null });
        this.store.markLegalNotified(first.monitor_id, events, new Date().toISOString());
        sent++;
        processedGroups++;
        this.onMutation();
        if (this.sendDelayMs && processedGroups < Math.max(1, Number(maxGroups) || 1)) await sleep(this.sendDelayMs);
      } catch (error) {
        const message = String(error?.message || 'Falha no envio').slice(0,500);
        if (attempted) {
          for (const event of events) this.store.markLegalEvent(event.id, {
            sendStatus:'uncertain',
            error:'Envio sem confirmação. O WA.Auto não reenviará automaticamente para evitar duplicidade.'
          });
        } else if (/envio anterior ainda em recuperação|proteger o envio|persistência remota/i.test(message)) {
          // Keep the events waiting. A future scan can resume after the durable
          // journal is reconciled, without losing or duplicating a notification.
          break;
        } else {
          for (const event of events) this.store.markLegalEvent(event.id, { sendStatus:'failed', error:message });
          failed += events.length;
        }
        this.onMutation();
        if (attempted) break;
      }
    }
    return { sent, failed, waiting:this.store.pendingLegalEvents(100).length };
  }
}
