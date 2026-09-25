import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSpreadsheet } from './importer.js';
import { analyzeContacts, createCampaign, prepareCampaign, csvReport } from './campaigns.js';
import { affirmative, blockedInRow, normalizePhone, fold } from './phone.js';
import { AppError, requireValue } from './errors.js';
import { normalizeCnj, resolveDataJudAlias, parseClientDate } from './legal-monitor.js';
import { registerDossierRoutes } from './dossier-routes.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const metadata = imported => ({ ...imported, sheets: imported.sheets.map(({ rows, ...sheet }) => ({ ...sheet, rowCount: rows.length })) });
const headerMatch = (sheet, patterns) => sheet.headers.find(header => patterns.some(pattern => pattern.test(fold(header)))) || '';
const legalSheetColumns = (sheet, body = {}) => ({
  processColumn: sheet.headers.includes(body.processColumn) ? body.processColumn : headerMatch(sheet, [/^protocolo$/, /protocolo.*ref/, /processo/, /^cnj$/]),
  phoneColumn: sheet.headers.includes(body.phoneColumn) ? body.phoneColumn : headerMatch(sheet, [/^telefone$/, /celular/, /whats/, /fone/]),
  nameColumn: sheet.headers.includes(body.nameColumn) ? body.nameColumn : headerMatch(sheet, [/^cliente$/, /^nome$/, /parte/]),
  consentColumn: sheet.headers.includes(body.consentColumn) ? body.consentColumn : headerMatch(sheet, [/autoriz/, /consent/, /opt.?in/, /whats.*ok/]),
  lastReturnColumn: sheet.headers.includes(body.lastReturnColumn) ? body.lastReturnColumn : headerMatch(sheet, [/^retorno$/, /ultimo.*retorno/, /ultimo_retorno/]),
  nextReturnColumn: sheet.headers.includes(body.nextReturnColumn) ? body.nextReturnColumn : headerMatch(sheet, [/proximo.*retorno/, /proximo_retorno/]),
  movementDateColumn: sheet.headers.includes(body.movementDateColumn) ? body.movementDateColumn : headerMatch(sheet, [/data.*moviment/, /datajud.*ultimo.*movimento/, /ultima.*moviment.*data/]),
  movementTextColumn: sheet.headers.includes(body.movementTextColumn) ? body.movementTextColumn : headerMatch(sheet, [/^andamento$/, /datajud.*ultimo.*nome/, /^ultima_movimentacao$/, /ultima.*moviment/]),
  djenDateColumn: sheet.headers.includes(body.djenDateColumn) ? body.djenDateColumn : headerMatch(sheet, [/djen.*ultima.*data/, /data.*djen/]),
  djenTextColumn: sheet.headers.includes(body.djenTextColumn) ? body.djenTextColumn : headerMatch(sheet, [/djen.*resumo/, /djen.*ultimo.*resumo/]),
  lastNotifiedColumn: sheet.headers.includes(body.lastNotifiedColumn) ? body.lastNotifiedColumn : headerMatch(sheet, [/alert.*delivered/, /ultimo.*aviso/, /ultima.*notificacao/]),
});
export function createApp({ store, transport, queue, legalMonitor = null, resourceGuard = null, onMutation = () => {} }) {
  const app = express();
  const csrfToken = randomBytes(32).toString('hex');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 0 } });
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
    });

    const isApi = req.path.startsWith('/api/');
    if (!isApi) return next();

    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = String(req.headers.origin || '').replace(/\/$/, '');
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || req.headers.host || '';
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    const requestOrigin = host ? `${protocol}://${host}` : '';
    const configuredOrigin = String(process.env.WA_PUBLIC_ORIGIN || '').replace(/\/$/, '');

    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Origem não permitida.' });
    if (origin && origin !== requestOrigin && (!configuredOrigin || origin !== configuredOrigin)) return res.status(403).json({ error: 'Origem não permitida.' });

    if (isMutation && req.headers['x-wa-csrf'] !== csrfToken) {
      return res.status(403).json({ error: 'Atualize a página e tente novamente.' });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  registerDossierRoutes(app);
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path.startsWith('/api/')) {
      res.on('finish', () => { if (res.statusCode < 500) onMutation(); });
    }
    next();
  });
  app.get('/api/health', (req, res) => {
    const resources = resourceGuard?.snapshot?.() || null;
    res.json({ ok: true, service: 'WA.Auto', pid: process.pid, uptime: Math.floor(process.uptime()), resources, whatsapp:transport.snapshot().status });
  });
  app.get('/api/bootstrap', (req, res) => res.json({ csrfToken, connection: transport.snapshot(), campaigns: store.campaigns(), latestImport: store.latestImport(), nextSendAt: Number(store.getMeta('nextSendAt') || 0), legal: legalMonitor?.snapshot?.() || store.legalStats(), resources:resourceGuard?.snapshot?.() || null }));
  app.get('/api/state', (req, res) => res.json({ connection: transport.snapshot(), campaigns: store.campaigns(), nextSendAt: Number(store.getMeta('nextSendAt') || 0), busy: queue.busy, legal: legalMonitor?.snapshot?.() || store.legalStats(), resources:resourceGuard?.snapshot?.() || null }));
  app.post('/api/whatsapp/connect', async (req, res) => { await transport.connect(); res.json(transport.snapshot()); });
  app.post('/api/whatsapp/pair', async (req, res) => {
    const { phone, error } = normalizePhone(req.body?.phone, '55');
    requireValue(phone && !error, error || 'Informe um telefone válido com DDD.');
    await transport.close();
    await transport.connect({ phoneNumber: phone });
    res.json(transport.snapshot());
  });
  app.post('/api/whatsapp/disconnect', async (req, res) => { await transport.close(); res.json(transport.snapshot()); });
  app.post('/api/whatsapp/logout', async (req, res) => { await transport.logout(); res.json(transport.snapshot()); });
  app.post('/api/imports', upload.single('file'), async (req, res) => {
    requireValue(req.file, 'Selecione uma planilha.');
    const imported = await parseSpreadsheet(req.file.buffer, req.file.originalname);
    const id = store.saveImport(imported);
    res.status(201).json(metadata({ id, ...imported }));
  });
  app.get('/api/imports/:id', (req, res) => res.json(metadata(store.getImport(req.params.id))));
  app.get('/api/imports/:id/contacts', (req, res) => {
    res.json(analyzeContacts(store, {
      importId: req.params.id,
      sheet: req.query.sheet,
      phoneColumn: req.query.phoneColumn,
      nameColumn: req.query.nameColumn || '',
      country: req.query.country || '55',
    }));
  });
  app.get('/api/imports/:id/values', (req, res) => {
    const imported = store.getImport(req.params.id);
    const sheet = imported.sheets.find(sheet => sheet.name === req.query.sheet);
    requireValue(sheet && sheet.headers.includes(req.query.column), 'Selecione uma coluna válida.');
    res.json([...new Set(sheet.rows.map(row => String(row.values[req.query.column])))].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  });
  app.post('/api/preview', (req, res) => res.json(prepareCampaign(store, req.body)));
  app.post('/api/campaigns', (req, res) => { const id = createCampaign(store, req.body); res.status(201).json(store.campaign(id)); });
  app.get('/api/campaigns/:id', (req, res) => res.json({ campaign: store.campaign(req.params.id), entries: store.entries(req.params.id).map(({ values, ...row }) => row) }));
  app.post('/api/campaigns/:id/start', (req, res) => { requireValue(req.body?.reviewed === true, 'Revise a mensagem e os destinatários antes de iniciar.'); queue.start(req.params.id); res.json(store.campaign(req.params.id)); });
  app.post('/api/campaigns/:id/pause', (req, res) => { queue.pause(req.params.id); res.json(store.campaign(req.params.id)); });
  app.post('/api/campaigns/:id/cancel', (req, res) => { queue.cancel(req.params.id); res.json(store.campaign(req.params.id)); });
  app.post('/api/campaigns/:id/entries/:entryId/resolve', (req, res) => {
    const campaign = store.campaign(req.params.id);
    requireValue(campaign.status !== 'running' && !queue.busy, 'Pause a campanha e aguarde o envio atual terminar antes de resolver esta linha.', 409);
    const entry = store.entry(Number(req.params.entryId));
    requireValue(entry && entry.campaign_id === req.params.id, 'Destinatário não encontrado nesta campanha.', 404);
    requireValue(entry.status === 'uncertain', 'Somente linhas em “Conferir no WhatsApp” podem ser resolvidas manualmente.', 409);
    requireValue(['sent', 'retry'].includes(req.body?.action), 'Escolha uma resolução válida.');
    if (req.body.action === 'sent') {
      store.updateEntry(entry.id, { status: 'sent', reason: 'Confirmada manualmente após conferência no WhatsApp.' });
      const counts = store.counts(req.params.id);
      const unresolved = ['pending', 'resolving', 'sending', 'uncertain'].some(status => (counts[status] || 0) > 0);
      if (!unresolved && ['draft', 'paused'].includes(campaign.status)) store.setCampaign(req.params.id, 'completed', 'Conferência manual concluída.');
    } else {
      store.updateEntry(entry.id, { status: 'pending', reason: 'Reenvio autorizado manualmente após conferência no WhatsApp.' });
      if (campaign.status === 'completed') store.setCampaign(req.params.id, 'paused', 'Há uma linha autorizada manualmente para novo envio.');
    }
    res.json({ campaign: store.campaign(req.params.id), entries: store.entries(req.params.id).map(({ values, ...row }) => row) });
  });
  app.get('/api/campaigns/:id/report.csv', (req, res) => {
    const campaign = store.campaign(req.params.id);
    res.set('Content-Disposition', `attachment; filename="wa-auto-${campaign.id.slice(0, 8)}.csv"`).type('text/csv; charset=utf-8').send(csvReport(campaign, store.entries(campaign.id)));
  });
  app.post('/api/test-message', (req, res) => {
    requireValue(transport.isReady(), 'Conecte o WhatsApp antes de testar.', 409);
    requireValue(!store.active() && !queue.busy, 'Pause a campanha e aguarde o envio atual antes de testar.', 409);
    const { phone, error } = normalizePhone(req.body.phone, '55');
    requireValue(phone && !error, error || 'Informe seu número.');
    requireValue(typeof req.body.message === 'string' && req.body.message.trim() && req.body.message.length <= 8000, 'Confira a mensagem de teste.');
    requireValue(!store.isBlocked(phone, `${phone}@c.us`), 'Este telefone está na lista de não contatar.');
    const id = store.createCampaign('Teste de mensagem', { intervalSeconds: 30, test: true }, [{ row: 1, name: 'Teste', phone, rawPhone: req.body.phone, values: {}, message: req.body.message, status: 'pending' }]);
    queue.start(id);
    res.status(201).json(store.campaign(id));
  });
  app.get('/api/legal/monitors', (req, res) => {
    res.json({ monitors: store.legalMonitors(), events: store.legalEvents(null, 250), stats: legalMonitor?.snapshot?.() || store.legalStats() });
  });
  app.get('/api/legal/monitors/:id/events', (req, res) => res.json(store.legalEvents(req.params.id, 250)));
  app.post('/api/legal/monitors', async (req, res) => {
    requireValue(legalMonitor, 'Monitor processual indisponível.', 503);
    const cnj = normalizeCnj(req.body?.cnj);
    requireValue(cnj, 'Informe um número CNJ válido com 20 dígitos.');
    const { phone, error } = normalizePhone(req.body?.phone, '55');
    requireValue(phone && !error, error || 'Informe um telefone válido com DDD.');
    requireValue(!store.isBlocked(phone, `${phone}@s.whatsapp.net`, `${phone}@c.us`), 'Este telefone está na lista de não contatar.');
    const mode = ['datajud','djen','both'].includes(req.body?.mode) ? req.body.mode : 'both';
    const monitor = store.createLegalMonitor({
      cnj,
      clientName:String(req.body?.clientName || 'Cliente').trim().slice(0,160) || 'Cliente',
      phone,
      tribunalAlias:resolveDataJudAlias(cnj),
      mode,
      notifyWhatsapp:req.body?.notifyWhatsapp !== false,
      lastReturnAt:parseClientDate(req.body?.lastReturnAt, { endOfDay:true })
    });
    if (req.body?.lastReturnAt) legalMonitor.syncSpreadsheetSnapshot(monitor, { lastReturnAt:req.body.lastReturnAt });
    const scan = await legalMonitor.scanOne(store.legalMonitor(monitor.id), { seedOnly:true });
    res.status(201).json({ monitor:store.legalMonitor(monitor.id), scan, events:store.legalEvents(monitor.id, 20) });
  });
  app.post('/api/legal/monitors/import', async (req, res) => {
    requireValue(legalMonitor, 'Monitor processual indisponível.', 503);
    const imported = store.getImport(req.body?.importId);
    const sheet = imported.sheets.find(item => item.name === req.body?.sheet) || imported.sheets.find(item => /^processos?$/i.test(item.name)) || imported.sheets[0];
    requireValue(sheet, 'Selecione uma aba válida.');
    const columns = legalSheetColumns(sheet, req.body || {});
    requireValue(columns.processColumn, 'Não encontrei a coluna do processo. Na sua planilha, use Protocolo/CNJ/Processo.');
    requireValue(columns.phoneColumn, 'Não encontrei a coluna de telefone.');

    const blockedPhones = new Set(
      sheet.rows
        .filter(row => blockedInRow(row.values))
        .map(row => normalizePhone(row.values[columns.phoneColumn], '55').phone)
        .filter(Boolean)
    );

    let created = 0, invalid = 0, blocked = 0, withoutConsent = 0, duplicates = 0;
    let queued = 0, baseline = 0, covered = 0, missingReturn = 0, withKnownMovement = 0;
    const ids = [];
    const seen = new Set();

    for (const row of sheet.rows) {
      const cnj = normalizeCnj(row.values[columns.processColumn]);
      const { phone } = normalizePhone(row.values[columns.phoneColumn], '55');
      if (!cnj || !phone) { invalid++; continue; }
      if (blockedInRow(row.values) || blockedPhones.has(phone) || store.isBlocked(phone, `${phone}@s.whatsapp.net`, `${phone}@c.us`)) { blocked++; continue; }
      if (columns.consentColumn && !affirmative(row.values[columns.consentColumn])) { withoutConsent++; continue; }

      const key = `${cnj}:${phone}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);

      const lastReturnRaw = columns.lastReturnColumn ? row.values[columns.lastReturnColumn] : '';
      const nextReturnRaw = columns.nextReturnColumn ? row.values[columns.nextReturnColumn] : '';
      const movementAtRaw = columns.movementDateColumn ? row.values[columns.movementDateColumn] : '';
      const movementText = columns.movementTextColumn ? row.values[columns.movementTextColumn] : '';
      const djenAtRaw = columns.djenDateColumn ? row.values[columns.djenDateColumn] : '';
      const djenText = columns.djenTextColumn ? row.values[columns.djenTextColumn] : '';
      const lastNotifiedRaw = columns.lastNotifiedColumn ? row.values[columns.lastNotifiedColumn] : '';
      if (!parseClientDate(lastReturnRaw, { endOfDay:true })) missingReturn++;
      if (parseClientDate(movementAtRaw) && String(movementText || '').trim()) withKnownMovement++;

      const monitor = store.createLegalMonitor({
        cnj,
        clientName:String(columns.nameColumn ? row.values[columns.nameColumn] || 'Cliente' : 'Cliente').trim().slice(0,160) || 'Cliente',
        phone,
        tribunalAlias:resolveDataJudAlias(cnj),
        mode:['datajud','djen','both'].includes(req.body?.mode) ? req.body.mode : 'both',
        notifyWhatsapp:req.body?.notifyWhatsapp !== false,
        lastReturnAt:parseClientDate(lastReturnRaw, { endOfDay:true }),
        nextReturnAt:parseClientDate(nextReturnRaw, { endOfDay:true }),
        sheetMovementAt:parseClientDate(movementAtRaw),
        sheetMovementText:String(movementText || ''),
        lastNotifiedAt:parseClientDate(lastNotifiedRaw),
        sourceImportId:imported.id,
        sourceSheet:sheet.name,
        sourceRow:row.id
      });

      const sync = legalMonitor.syncSpreadsheetSnapshot(monitor, {
        lastReturnAt:lastReturnRaw,
        nextReturnAt:nextReturnRaw,
        movementAt:movementAtRaw,
        movementText,
        djenAt:djenAtRaw,
        djenText,
        lastNotifiedAt:lastNotifiedRaw,
        sourceImportId:imported.id,
        sourceSheet:sheet.name,
        sourceRow:row.id
      });
      queued += sync.queued;
      baseline += sync.baseline;
      covered += sync.covered;
      ids.push(monitor.id);
      created++;
    }

    // Se o WhatsApp já estiver conectado, dispara no máximo um aviso agora.
    // O restante continua na fila automática com espaçamento, sem travar a importação.
    const delivery = await legalMonitor.sendPendingNotifications({ maxGroups:1 });
    res.status(201).json({
      created, invalid, blocked, withoutConsent, duplicates, queued, baseline, covered,
      missingReturn, withKnownMovement, sentNow:delivery.sent || 0, waiting:delivery.waiting || 0,
      columns, sheet:sheet.name, monitors:ids
    });
  });
  app.post('/api/legal/monitors/:id/toggle', (req, res) => {
    const current = store.legalMonitor(req.params.id);
    res.json(store.updateLegalMonitor(req.params.id, {
      enabled:req.body?.enabled == null ? !current.enabled : !!req.body.enabled,
      notify_whatsapp:req.body?.notifyWhatsapp == null ? current.notify_whatsapp : !!req.body.notifyWhatsapp
    }));
  });
  app.delete('/api/legal/monitors/:id', (req, res) => { store.deleteLegalMonitor(req.params.id); res.json({ ok:true }); });
  app.post('/api/legal/scan', async (req, res) => {
    requireValue(legalMonitor, 'Monitor processual indisponível.', 503);
    res.json(await legalMonitor.trigger({ force:true }));
  });
  app.post('/api/legal/monitors/:id/scan', async (req, res) => {
    requireValue(legalMonitor, 'Monitor processual indisponível.', 503);
    res.json(await legalMonitor.scanOne(req.params.id));
  });
  app.get('/api/legal/cron', async (req, res) => {
    requireValue(legalMonitor, 'Monitor processual indisponível.', 503);
    res.json(await legalMonitor.trigger({ force:false }));
  });

  app.get('/api/suppressions', (req, res) => res.json(store.suppressions()));
  app.post('/api/suppressions', (req, res) => {
    const { phone, error } = normalizePhone(req.body.phone);
    requireValue(phone, error);
    store.suppress(phone, String(req.body.reason || 'Bloqueado por você').slice(0, 250));
    res.status(201).json({ phone });
  });
  app.delete('/api/suppressions/:identity', (req, res) => { store.removeSuppression(req.params.identity); res.json({ ok: true }); });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Operação não encontrada.' }));
  app.use(express.static(publicDir, { etag: false, maxAge: 0 }));
  app.get('/modelo.csv', (req, res) => res.download(path.join(publicDir, 'modelo.csv')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AppError ? error.status : error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof multer.MulterError ? 400 : error.type === 'entity.parse.failed' ? 400 : error.status === 413 ? 413 : 500;
    const message = error instanceof AppError ? error.message : status === 413 ? 'Arquivo ou pedido grande demais. A planilha deve ter até 15 MB.' : status === 400 ? 'Formato da solicitação inválido.' : 'Não foi possível concluir a operação. Confira a conexão e tente novamente.';
    res.status(status).json({ error: message });
  });
  return app;
}
