import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSpreadsheet } from './importer.js';
import { createCampaign, prepareCampaign, csvReport } from './campaigns.js';
import { normalizePhone } from './phone.js';
import { AppError, requireValue } from './errors.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const metadata = imported => ({ ...imported, sheets: imported.sheets.map(({ rows, ...sheet }) => ({ ...sheet, rowCount: rows.length })) });
export function createApp({ store, transport, queue }) {
  const app = express();
  const csrfToken = randomBytes(32).toString('hex');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 0 } });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
    });
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: 'Acesso permitido apenas pelo endereço local.' });

    const origin = req.headers.origin;
    const localOrigin = `http://${host}`;
    const cloudOrigin = process.env.WA_CLOUD_ORIGIN || 'https://whatsappautomat.vercel.app';
    const allowedOrigin = !origin || origin === localOrigin || origin === cloudOrigin;
    if (!allowedOrigin) return res.status(403).json({ error: 'Origem não permitida.' });
    if (req.headers['sec-fetch-site'] === 'cross-site' && origin !== cloudOrigin) return res.status(403).json({ error: 'Origem não permitida.' });

    if (origin === cloudOrigin) {
      res.set({
        'Access-Control-Allow-Origin': cloudOrigin,
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-WA-CSRF',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin',
      });
      if (req.headers['access-control-request-private-network'] === 'true') res.set('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }

    if (req.path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-wa-csrf'] !== csrfToken) return res.status(403).json({ error: 'Atualize a página e tente novamente.' });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'WA.Auto', pid: process.pid, uptime: Math.floor(process.uptime()) }));
  app.get('/api/bootstrap', (req, res) => res.json({ csrfToken, connection: transport.snapshot(), campaigns: store.campaigns(), latestImport: store.latestImport(), nextSendAt: Number(store.getMeta('nextSendAt') || 0) }));
  app.get('/api/state', (req, res) => res.json({ connection: transport.snapshot(), campaigns: store.campaigns(), nextSendAt: Number(store.getMeta('nextSendAt') || 0), busy: queue.busy }));
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
