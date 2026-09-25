const $ = id => document.getElementById(id);
const HOSTED_MODE = !['127.0.0.1', 'localhost'].includes(location.hostname);
const API_ORIGIN = HOSTED_MODE ? 'http://127.0.0.1:3210' : '';
const apiUrl = url => `${API_ORIGIN}${url}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = { draft: 'Rascunho', running: 'Em andamento', paused: 'Pausada', completed: 'Concluída', cancelled: 'Cancelada', pending: 'Pronta para enviar', resolving: 'Conferindo número', sending: 'Enviando', sent: 'Enviada', delivered: 'Entregue', read: 'Lida', uncertain: 'Conferir no WhatsApp', invalid: 'Revisar dados', duplicate: 'Repetido', skipped: 'Não contatar', excluded: 'Não selecionado', failed_delivery: 'Falha de entrega' };
const badge = status => `<span class="badge ${escape(status)}">${escape(labels[status] || status)}</span>`;
const number = value => Number(value || 0).toLocaleString('pt-BR');
const state = { token: '', imported: null, connection: { status: 'disconnected', message: 'Motor local desligado.' }, campaigns: [], preview: null, selected: new Set(), reviewPage: 0, detailPage: 0, activeId: null, detail: null, saved: false, online: !HOSTED_MODE, engineAvailable: !HOSTED_MODE };
const PAGE_SIZE = 25;
let toastTimer;

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7000 : 4200);
}
function requireEngine() {
  if (HOSTED_MODE && !state.engineAvailable) throw new Error('O motor local está desligado. Abra o WA.Auto para Windows e depois clique em Conectar motor.');
}
async function api(url, options = {}) {
  if (HOSTED_MODE && !state.engineAvailable && !options.allowOfflineProbe) requireEngine();
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  if (options.method && options.method !== 'GET') headers['X-WA-CSRF'] = state.token;
  let response;
  try {
    const { allowOfflineProbe, ...fetchOptions } = options;
    response = await fetch(apiUrl(url), {
      ...fetchOptions,
      headers,
      cache: 'no-store',
      ...(HOSTED_MODE ? { targetAddressSpace: 'local' } : {}),
    });
  } catch {
    throw new Error(HOSTED_MODE
      ? 'O painel abriu, mas o motor local não respondeu. Abra INICIAR-WINDOWS.cmd neste computador, permita o acesso à rede local no Chrome e tente novamente.'
      : 'O WA.Auto não respondeu. Confira se a janela do programa continua aberta.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir.');
  return result;
}
async function perform(button, action) {
  if (button?.dataset.working === 'true') return;
  if (button) { button.dataset.working = 'true'; button.disabled = true; }
  try { await action(); }
  catch (error) { toast(error.message, true); }
  finally { if (button) { button.dataset.working = 'false'; button.disabled = false; } refreshControls(); }
}
const onClick = (id, fn) => $(id).addEventListener('click', () => void perform($(id), fn));
const modal = id => { if (!$(id).open) $(id).showModal(); };
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });

function fields() {
  return { importId: state.imported?.id, sheet: $('sheet').value, phoneColumn: $('phone-column').value, nameColumn: $('name-column').value, consentColumn: $('consent-column').value, filterColumn: $('filter-column').value, filterValue: $('filter-value').value, country: $('country').value, name: $('campaign-name').value, template: $('template').value, intervalSeconds: Number($('interval').value) };
}
function saveDraft() { try { localStorage.setItem('wa-auto-draft', JSON.stringify(fields())); } catch {} }
function getDraft() { try { return JSON.parse(localStorage.getItem('wa-auto-draft') || '{}'); } catch { return {}; } }
function invalidate() {
  state.preview = null;
  state.selected.clear();
  state.saved = false;
  $('review-panel').classList.add('hidden');
  saveDraft();
  renderMessage();
  refreshControls();
}
function options(element, values, selected = '', placeholder = 'Não usar') {
  element.replaceChildren();
  if (placeholder !== null) element.add(new Option(placeholder, ''));
  for (const value of values) element.add(new Option(value, value));
  element.value = values.includes(selected) ? selected : placeholder === null ? (values[0] || '') : '';
}
function configureSheet(saved = {}) {
  const sheet = state.imported.sheets.find(sheet => sheet.name === $('sheet').value);
  options($('phone-column'), sheet.headers, saved.phoneColumn || sheet.suggestedPhone, 'Selecione a coluna');
  options($('name-column'), sheet.headers, saved.nameColumn || sheet.suggestedName);
  options($('consent-column'), sheet.headers, saved.consentColumn || '');
  options($('filter-column'), sheet.headers, saved.filterColumn || '', 'Todas as linhas');
  options($('filter-value'), [], '', 'Escolha uma coluna');
  $('filter-value').disabled = true;
  $('variables').innerHTML = sheet.headers.map(header => `<button class="variable-chip" data-variable="${escape(header)}">{{${escape(header)}}}</button>`).join('');
  for (const button of $('variables').querySelectorAll('button')) button.addEventListener('click', () => {
    const area = $('template');
    area.setRangeText(`{{${button.dataset.variable}}}`, area.selectionStart, area.selectionEnd, 'end');
    area.focus(); invalidate();
  });
  if ($('filter-column').value) void perform(null, () => loadFilterValues(saved.filterValue));
  invalidate();
}
function setImport(imported, draft = {}) {
  state.imported = imported;
  $('mapping').classList.remove('hidden');
  $('upload-title').textContent = imported.filename;
  $('upload-subtitle').textContent = `${imported.sheets.length} aba(s) · clique para trocar o arquivo`;
  const first = imported.sheets.find(sheet => sheet.suggestedPhone && sheet.rowCount) || imported.sheets[0];
  options($('sheet'), imported.sheets.map(sheet => sheet.name), draft.sheet || first.name, null);
  configureSheet(draft);
}
async function loadFilterValues(selected = '') {
  if (!$('filter-column').value) { options($('filter-value'), [], '', 'Todas as linhas'); $('filter-value').disabled = true; invalidate(); return; }
  const column = $('filter-column').value;
  const sheet = $('sheet').value;
  const values = await api(`/api/imports/${state.imported.id}/values?${new URLSearchParams({ sheet, column })}`);
  if (column !== $('filter-column').value || sheet !== $('sheet').value) return;
  options($('filter-value'), values, selected, null);
  $('filter-value').disabled = false;
  invalidate();
}
async function uploadFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) throw new Error('A planilha deve ter até 15 MB.');
  $('upload-title').textContent = 'Lendo sua planilha…';
  const form = new FormData(); form.append('file', file);
  try { const imported = await api('/api/imports', { method: 'POST', body: form }); setImport(imported); toast('Planilha importada. Confira a aba e as colunas.'); }
  finally { $('upload-title').textContent = state.imported?.filename || 'Clique ou arraste sua planilha aqui'; $('file-input').value = ''; }
}
$('file-input').addEventListener('change', event => void perform($('review'), () => uploadFile(event.target.files[0])));
$('drop-zone').addEventListener('dragover', event => { event.preventDefault(); $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); void perform($('review'), () => uploadFile(event.dataTransfer.files[0])); });
$('sheet').addEventListener('change', () => configureSheet());
$('filter-column').addEventListener('change', () => void perform(null, () => loadFilterValues()));
for (const id of ['phone-column', 'name-column', 'consent-column', 'filter-value', 'country', 'template']) $(id).addEventListener('input', invalidate);
for (const id of ['campaign-name', 'interval']) $(id).addEventListener('input', saveDraft);

function firstSelected() { return state.preview?.entries.find(row => row.status === 'pending' && state.selected.has(row.row)); }
function renderMessage(entry = firstSelected()) {
  $('char-count').textContent = `${number($('template').value.length)} / 8.000`;
  $('message-preview').textContent = entry?.message || $('template').value || 'Sua mensagem vai aparecer aqui. Importe a planilha e escreva o texto ao lado.';
  $('preview-name').textContent = entry?.name || 'Seu cliente';
  $('preview-avatar').textContent = (entry?.name || 'C').trim().charAt(0).toUpperCase();
}
onClick('sample-template', () => {
  const greeting = $('name-column').value ? `, {{${$('name-column').value}}}` : '';
  $('template').value = `Olá${greeting}! Tudo bem?\n\nEntramos em contato para acompanhar seu atendimento. Podemos conversar por aqui?\n\nSe preferir não receber mensagens, responda SAIR.`;
  invalidate();
});
onClick('review', async () => {
  state.preview = await api('/api/preview', { method: 'POST', body: fields() });
  state.selected = new Set(state.preview.entries.filter(row => row.status === 'pending').map(row => row.row));
  state.reviewPage = 0; state.saved = false;
  $('review-panel').classList.remove('hidden');
  renderReview(); renderMessage();
  $('review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
function updateSelectionSummary() {
  const total = state.preview.entries.length;
  const available = state.preview.entries.filter(row => row.status === 'pending').length;
  $('review-summary').textContent = `${number(state.selected.size)} selecionado(s) · ${number(total - available)} linha(s) fora do envio · ${number(total)} linha(s) na revisão`;
  $('select-all').checked = available > 0 && state.selected.size === available;
  $('select-all').indeterminate = state.selected.size > 0 && state.selected.size < available;
  refreshControls(); renderMessage();
}
function renderReview() {
  if (!state.preview) return;
  const rows = state.preview.entries;
  const offset = state.reviewPage * PAGE_SIZE;
  $('review-rows').innerHTML = rows.slice(offset, offset + PAGE_SIZE).map(row => `<tr><td><input type="checkbox" data-row="${row.row}" aria-label="Selecionar linha ${row.row}" ${state.selected.has(row.row) ? 'checked' : ''} ${row.status === 'pending' ? '' : 'disabled'}></td><td>${row.row}</td><td>${escape(row.name)}</td><td>${escape(row.phone ? `+${row.phone}` : row.rawPhone || '—')}</td><td>${badge(row.status)}${row.reason ? `<div class="row-reason">${escape(row.reason)}</div>` : ''}</td><td><button class="text-link" data-message="${row.row}">Ver texto ↗</button></td></tr>`).join('');
  for (const checkbox of $('review-rows').querySelectorAll('[data-row]')) checkbox.addEventListener('change', () => { const id = Number(checkbox.dataset.row); if (checkbox.checked) state.selected.add(id); else state.selected.delete(id); state.saved = false; updateSelectionSummary(); });
  for (const button of $('review-rows').querySelectorAll('[data-message]')) button.addEventListener('click', () => { const row = rows.find(row => row.row === Number(button.dataset.message)); $('full-message').textContent = row.message; renderMessage(row); modal('text-dialog'); });
  $('review-page-label').textContent = `${number(rows.length ? offset + 1 : 0)}–${number(Math.min(offset + PAGE_SIZE, rows.length))} de ${number(rows.length)}`;
  $('review-prev').disabled = state.reviewPage === 0;
  $('review-next').disabled = offset + PAGE_SIZE >= rows.length;
  updateSelectionSummary();
}
$('select-all').addEventListener('change', () => { state.selected = new Set($('select-all').checked ? state.preview.entries.filter(row => row.status === 'pending').map(row => row.row) : []); state.saved = false; renderReview(); });
$('review-prev').addEventListener('click', () => { state.reviewPage = Math.max(0, state.reviewPage - 1); renderReview(); });
$('review-next').addEventListener('click', () => { state.reviewPage++; renderReview(); });
onClick('save-campaign', async () => {
  const campaign = await api('/api/campaigns', { method: 'POST', body: { ...fields(), selectedRows: [...state.selected] } });
  state.saved = true;
  await poll(); await openCampaign(campaign.id);
  toast('Campanha salva. Confira os contatos antes de iniciar.');
});
onClick('new-campaign', () => {
  $('campaign-name').value = ''; $('template').value = ''; state.saved = false; invalidate();
  $('campaign-name').focus(); $('campaign-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function renderConnection() {
  const current = state.connection;
  const ready = current.status === 'ready';
  const waiting = ['connecting', 'qr', 'pairing', 'authenticated'].includes(current.status);
  $('connection-dot').className = `status-dot${ready ? ' ready' : waiting ? ' waiting' : ''}`;
  $('connection-label').textContent = HOSTED_MODE && !state.engineAvailable ? 'Motor local desligado' : !state.online ? 'App sem conexão' : ready ? 'WhatsApp conectado' : waiting ? 'Conectando WhatsApp' : 'WhatsApp desconectado';
  let content;
  if (HOSTED_MODE && !state.engineAvailable) content = '<div><div class="connected-avatar">!</div><p class="muted">O painel web está aberto, mas o motor do WhatsApp não está rodando neste PC.</p><p class="muted">1. Baixe o iniciador.<br>2. Execute no Windows.<br>3. Volte aqui e clique em Conectar motor.</p><a class="button secondary" href="/INICIAR-WA.AUTO.cmd" download>Baixar iniciador Windows ↓</a></div>';
  else if (current.qr) content = `<img src="${escape(current.qr)}" alt="QR Code para conectar o seu WhatsApp">`;
  else if (current.pairingCode) content = `<div class="pairing-code-box"><span class="eyebrow">CÓDIGO DE PAREAMENTO</span><strong class="pairing-code">${escape(current.pairingCode)}</strong><p class="muted">Digite este código no WhatsApp do celular.</p></div>`;
  else if (ready) content = `<div><div class="connected-avatar">✓</div><p class="connection-account">${escape(current.account?.name)}</p><p class="connection-number">${escape(current.account?.phone ? `+${current.account.phone}` : '')}</p></div>`;
  else if (waiting) content = '<div><span class="loader"></span><p class="muted">Preparando sua conexão…</p></div>';
  else content = '<div><div class="connected-avatar">↗</div><p class="muted">Seu WhatsApp, neste computador.</p></div>';
  const markup = `<div class="qr-container">${content}</div><p class="connection-message">${escape(current.message || 'Conecte seu WhatsApp para começar.')}</p>`;
  if ($('connection-content').innerHTML !== markup) $('connection-content').innerHTML = markup;
  $('connect-action').textContent = HOSTED_MODE && !state.engineAvailable ? 'Conectar motor' : ready || waiting ? 'Desconectar' : 'Gerar QR Code';
  $('pair-action').textContent = current.status === 'pairing' ? 'Gerar outro código' : 'Gerar código de pareamento';
  $('pair-action').disabled = HOSTED_MODE && !state.engineAvailable;
  $('forget-session').disabled = HOSTED_MODE && !state.engineAvailable;
  refreshControls();
}
$('connection-open').addEventListener('click', () => { renderConnection(); modal('connection-dialog'); });
onClick('connect-action', async () => {
  if (HOSTED_MODE && !state.engineAvailable) {
    await connectEngine();
    if (!state.engineAvailable) return;
  }
  const connected = ['ready', 'connecting', 'qr', 'pairing', 'authenticated'].includes(state.connection.status);
  state.connection = await api(`/api/whatsapp/${connected ? 'disconnect' : 'connect'}`, { method: 'POST' }); renderConnection();
});
onClick('pair-action', async () => {
  const phone = $('pair-phone').value.trim();
  if (!phone) throw new Error('Informe seu telefone com DDD para gerar o código.');
  state.connection = await api('/api/whatsapp/pair', { method: 'POST', body: { phone } });
  renderConnection();
});
onClick('forget-session', async () => {
  if (!confirm('Remover a sessão salva deste computador? Você precisará escanear outro QR Code.')) return;
  state.connection = await api('/api/whatsapp/logout', { method: 'POST' }); renderConnection();
});

function renderHistory() {
  const list = state.campaigns;
  const sum = statuses => list.reduce((count, campaign) => count + statuses.reduce((s, status) => s + (campaign.counts[status] || 0), 0), 0);
  $('stat-campaigns').textContent = number(list.length);
  $('stat-sent').textContent = number(sum(['sent', 'delivered', 'read']));
  $('stat-delivered').textContent = number(sum(['delivered', 'read']));
  $('stat-pending').textContent = number(sum(['pending', 'resolving', 'sending']));
  const markup = list.length ? list.map(campaign => {
    const done = ['sent', 'delivered', 'read'].reduce((n, key) => n + (campaign.counts[key] || 0), 0);
    const pending = ['pending', 'resolving', 'sending'].reduce((n, key) => n + (campaign.counts[key] || 0), 0);
    const date = new Date(campaign.created_at).toLocaleDateString('pt-BR');
    return `<div class="history-row"><span class="history-icon">↗</span><div class="history-info"><strong>${escape(campaign.name)}</strong><small>${date} · ${number(done)} enviada(s) · ${number(pending)} pendente(s)</small></div>${badge(campaign.status)}<button class="button small secondary" data-campaign="${escape(campaign.id)}">Acompanhar →</button></div>`;
  }).join('') : '<div class="empty-history"><span>▦</span><div><strong>Seu primeiro envio começa aqui.</strong><p>Importe uma planilha, escreva a mensagem e salve sua campanha.</p></div></div>';
  if ($('campaign-list').innerHTML === markup) return;
  $('campaign-list').innerHTML = markup;
  for (const button of $('campaign-list').querySelectorAll('[data-campaign]')) button.addEventListener('click', () => void perform(button, () => openCampaign(button.dataset.campaign)));
}
async function openCampaign(id) {
  const detail = await api(`/api/campaigns/${id}`);
  state.activeId = id; state.detail = detail; state.detailPage = 0;
  $('reviewed').checked = false;
  $('detail-message').textContent = detail.entries.find(row => row.status === 'pending')?.message || detail.entries.find(row => row.message)?.message || '';
  renderDetail(); modal('campaign-dialog');
}
function renderDetail() {
  if (!state.detail) return;
  const { campaign, entries } = state.detail;
  $('campaign-dialog-title').textContent = campaign.name;
  const sent = ['sent', 'delivered', 'read'].reduce((n, key) => n + (campaign.counts[key] || 0), 0);
  const delivered = (campaign.counts.delivered || 0) + (campaign.counts.read || 0);
  $('campaign-detail-summary').innerHTML = `<div class="detail-summary">${badge(campaign.status)}<span>${number(sent)} enviada(s)</span><span>${number(delivered)} entregue(s)</span><span>${number(campaign.counts.pending)} pendente(s)</span><span>${number(campaign.counts.uncertain)} para conferir</span></div>${campaign.reason ? `<div class="reason-banner">${escape(campaign.reason)}</div>` : ''}`;
  $('export-report').href = apiUrl(`/api/campaigns/${campaign.id}/report.csv`);
  $('export-report').setAttribute('download', '');
  const rows = entries.slice(state.detailPage * PAGE_SIZE, (state.detailPage + 1) * PAGE_SIZE);
  const markup = rows.map(row => {
    const resolution = row.status === 'uncertain' && campaign.status !== 'running'
      ? `<div class="manual-resolution"><button class="text-link" data-resolve-entry="${row.id}" data-resolution="sent">Já chegou</button><button class="text-link" data-resolve-entry="${row.id}" data-resolution="retry">Tentar novamente</button></div>`
      : '';
    return `<tr><td>${row.row_num}</td><td><button class="text-link" data-detail-entry="${row.id}">${escape(row.name)}</button></td><td>${escape(row.phone ? `+${row.phone}` : row.raw_phone || '—')}</td><td>${badge(row.status)}</td><td>${escape(row.reason || (row.message_id ? 'Registro confirmado pelo WhatsApp' : '—'))}${resolution}</td></tr>`;
  }).join('');
  if ($('campaign-detail-rows').innerHTML !== markup) {
    $('campaign-detail-rows').innerHTML = markup;
    for (const button of $('campaign-detail-rows').querySelectorAll('[data-detail-entry]')) button.addEventListener('click', () => { $('detail-message').textContent = entries.find(row => row.id === Number(button.dataset.detailEntry)).message; });
    for (const button of $('campaign-detail-rows').querySelectorAll('[data-resolve-entry]')) button.addEventListener('click', () => void perform(button, async () => {
      const action = button.dataset.resolution;
      if (action === 'retry' && !confirm('Você conferiu a conversa e tem certeza de que esta mensagem não chegou? Esta linha voltará para a fila e poderá ser enviada novamente.')) return;
      const detail = await api(`/api/campaigns/${campaign.id}/entries/${button.dataset.resolveEntry}/resolve`, { method: 'POST', body: { action } });
      state.detail = detail;
      renderDetail();
      await poll();
      toast(action === 'sent' ? 'Linha marcada como já enviada.' : 'Linha devolvida à fila. Revise e clique em Continuar envios.');
    }));
  }
  $('detail-page-label').textContent = `${number(entries.length ? state.detailPage * PAGE_SIZE + 1 : 0)}–${number(Math.min((state.detailPage + 1) * PAGE_SIZE, entries.length))} de ${number(entries.length)}`;
  $('detail-prev').disabled = !state.detailPage;
  $('detail-next').disabled = (state.detailPage + 1) * PAGE_SIZE >= entries.length;
  refreshControls();
}
function refreshControls() {
  const disable = (id, value) => { if ($(id).dataset.working !== 'true') $(id).disabled = !!value; };
  disable('review', !state.imported || !$('phone-column').value || !$('template').value.trim() || !state.online);
  disable('save-campaign', !state.preview || !state.selected.size || state.saved || !state.online);
  disable('test-message', !state.preview || !state.selected.size || !state.online);
  disable('connect-action', !state.online);
  disable('pair-action', !state.online || state.connection.status === 'ready');
  disable('forget-session', !state.online);
  if (state.detail) {
    const campaign = state.detail.campaign;
    const canStart = ['draft', 'paused'].includes(campaign.status) && campaign.counts.pending > 0;
    $('reviewed-label').classList.toggle('hidden', !canStart);
    $('start-campaign').classList.toggle('hidden', !canStart);
    $('start-campaign').textContent = campaign.status === 'paused' ? 'Continuar envios →' : 'Iniciar envios →';
    disable('start-campaign', !canStart || !$('reviewed').checked || state.connection.status !== 'ready' || !state.online);
    disable('pause-campaign', campaign.status !== 'running' || !state.online);
    disable('cancel-campaign', ['cancelled', 'completed'].includes(campaign.status) || !state.online);
  }
}
$('reviewed').addEventListener('change', refreshControls);
$('detail-prev').addEventListener('click', () => { state.detailPage = Math.max(0, state.detailPage - 1); renderDetail(); });
$('detail-next').addEventListener('click', () => { state.detailPage++; renderDetail(); });
for (const [button, action] of [['start-campaign', 'start'], ['pause-campaign', 'pause'], ['cancel-campaign', 'cancel']]) onClick(button, async () => {
  if (action === 'cancel' && !confirm('Cancelar as mensagens pendentes desta campanha? Envios já iniciados podem concluir.')) return;
  await api(`/api/campaigns/${state.activeId}/${action}`, { method: 'POST', body: { reviewed: $('reviewed').checked } });
  if (action === 'start') $('reviewed').checked = false;
  await poll();
});
onClick('test-message', () => {
  if (state.connection.status !== 'ready') { modal('connection-dialog'); toast('Conecte o WhatsApp para enviar o teste.'); return; }
  $('test-preview').textContent = firstSelected().message;
  $('test-phone').value = state.connection.account?.phone ? `+${state.connection.account.phone}` : '';
  modal('test-dialog');
});
onClick('send-test', async () => {
  const campaign = await api('/api/test-message', { method: 'POST', body: { phone: $('test-phone').value, message: $('test-preview').textContent } });
  $('test-dialog').close(); await poll(); await openCampaign(campaign.id);
  toast('Teste colocado na fila. Acompanhe a confirmação.');
});

async function renderBlocked() {
  const rows = await api('/api/suppressions');
  $('blocked-count').textContent = rows.length ? number(rows.length) : '';
  $('blocked-list').innerHTML = rows.length ? rows.map(row => `<div class="blocked-row"><div><strong>${escape(row.identity)}</strong><small>${escape(row.reason)}</small></div><button class="text-link" data-unblock="${escape(row.identity)}">Remover</button></div>`).join('') : '<p class="muted">Nenhum contato na lista.</p>';
  for (const button of $('blocked-list').querySelectorAll('[data-unblock]')) button.addEventListener('click', () => void perform(button, async () => {
    if (!confirm('Remover este bloqueio? Faça isso apenas se o cliente voltou a autorizar o contato. Linhas já excluídas não são reenviadas.')) return;
    await api(`/api/suppressions/${encodeURIComponent(button.dataset.unblock)}`, { method: 'DELETE' }); await renderBlocked();
  }));
}
$('block-form').addEventListener('submit', event => { event.preventDefault(); void perform(event.submitter, async () => { await api('/api/suppressions', { method: 'POST', body: { phone: $('block-phone').value, reason: $('block-reason').value } }); $('block-phone').value = ''; $('block-reason').value = ''; await renderBlocked(); toast('Telefone adicionado à lista.'); }); });
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => {
  for (const page of document.querySelectorAll('main>.page')) page.classList.toggle('hidden', page.id !== `page-${button.dataset.page}`);
  for (const nav of document.querySelectorAll('[data-page]')) nav.classList.toggle('active', nav === button);
  $('page-title').textContent = { campaigns: 'Campanhas', blocked: 'Não contatar', help: 'Como usar' }[button.dataset.page];
  if (button.dataset.page === 'blocked') void perform(null, renderBlocked);
});

let polling = false;
let pollTimer = null;

function hostedOfflineBanner(message = 'Motor local desligado.') {
  const banner = $('global-error');
  banner.className = 'info';
  banner.innerHTML = `${escape(message)} <strong>Para usar planilhas e WhatsApp:</strong> <a href="/INICIAR-WA.AUTO.cmd" download>baixe e execute o iniciador Windows</a> e depois <button class="text-link" id="retry-engine">Conectar motor</button>.`;
  $('retry-engine')?.addEventListener('click', () => void perform($('retry-engine'), connectEngine));
}

async function connectEngine() {
  if (!HOSTED_MODE) return true;
  try {
    const response = await api('/api/bootstrap', { allowOfflineProbe: true });
    state.engineAvailable = true;
    state.online = true;
    state.token = response.csrfToken;
    state.connection = response.connection;
    state.campaigns = response.campaigns;
    $('global-error').classList.add('hidden');
    renderConnection();
    renderHistory();
    const draft = getDraft();
    if (response.latestImport) {
      const imported = await api(`/api/imports/${response.latestImport.id}`);
      setImport(imported, draft.importId === imported.id ? draft : {});
    }
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 2000);
    toast('Motor local conectado.');
    return true;
  } catch {
    state.engineAvailable = false;
    state.online = false;
    state.connection = { status: 'disconnected', message: 'Motor local desligado.' };
    hostedOfflineBanner('Não encontrei o motor em 127.0.0.1:3210.');
    renderConnection();
    return false;
  }
}

async function poll() {
  if (polling || (HOSTED_MODE && !state.engineAvailable)) return;
  polling = true;
  try {
    const response = await api('/api/state');
    state.online = true; state.engineAvailable = true; state.connection = response.connection; state.campaigns = response.campaigns;
    $('global-error').classList.add('hidden');
    renderConnection(); renderHistory();
    if ($('campaign-dialog').open && state.activeId) {
      const id = state.activeId;
      const detail = await api(`/api/campaigns/${id}`);
      if (id === state.activeId) { state.detail = detail; renderDetail(); }
    }
  } catch (error) {
    state.online = false;
    if (HOSTED_MODE) {
      state.engineAvailable = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      hostedOfflineBanner('O motor local foi encerrado.');
    } else {
      $('global-error').textContent = error.message;
      $('global-error').classList.remove('hidden');
    }
    renderConnection();
  } finally { polling = false; }
}

async function init() {
  const draft = getDraft();
  $('campaign-name').value = draft.name || '';
  $('template').value = draft.template || '';
  $('interval').value = draft.intervalSeconds || 30;
  $('country').value = draft.country || '55';
  renderMessage();

  if (HOSTED_MODE) {
    document.documentElement.dataset.hosted = 'true';
    const localDot = document.querySelector('.sidebar-bottom .local-dot');
    if (localDot) localDot.innerHTML = '<span></span> Painel web · motor no PC';
    state.online = false;
    state.engineAvailable = false;
    hostedOfflineBanner('Painel carregado. O motor local ainda não está conectado.');
    renderConnection();
    renderHistory();
    refreshControls();
    return;
  }

  const response = await api('/api/bootstrap');
  state.token = response.csrfToken; state.connection = response.connection; state.campaigns = response.campaigns;
  renderConnection(); renderHistory();
  if (response.latestImport) {
    const imported = await api(`/api/imports/${response.latestImport.id}`);
    setImport(imported, draft.importId === imported.id ? draft : {});
  }
  refreshControls();
  pollTimer = setInterval(() => void poll(), 2000);
}

void init().catch(error => {
  state.online = false;
  $('global-error').textContent = error.message;
  $('global-error').classList.remove('hidden');
  renderConnection();
});
