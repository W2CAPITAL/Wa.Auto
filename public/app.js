const $ = id => document.getElementById(id);
const apiUrl = url => url;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = { draft: 'Rascunho', running: 'Em andamento', paused: 'Pausada', completed: 'Concluída', cancelled: 'Cancelada', valid: 'Válido', pending: 'Pronta para enviar', resolving: 'Conferindo número', sending: 'Enviando', sent: 'Enviada', delivered: 'Entregue', read: 'Lida', uncertain: 'Conferir no WhatsApp', invalid: 'Revisar dados', duplicate: 'Repetido', skipped: 'Não contatar', excluded: 'Não selecionado', failed_delivery: 'Falha de entrega' };
const badge = status => `<span class="badge ${escape(status)}">${escape(labels[status] || status)}</span>`;
const number = value => Number(value || 0).toLocaleString('pt-BR');
const state = { token: '', imported: null, contacts: null, contactPage: 0, contactFilter: 'all', contactSelection: new Set(), contactLoadSeq: 0, searchQuery: '', connection: { status: 'disconnected', message: 'Conecte seu WhatsApp para começar.' }, campaigns: [], legal: { monitored: 0, alerts: 0, sent: 0, lastScan: null, busy: false }, legalData: { monitors: [], events: [] }, preview: null, selected: new Set(), reviewPage: 0, detailPage: 0, activeId: null, detail: null, saved: false, online: true };
const PAGE_SIZE = 25;
let toastTimer;

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7000 : 4200);
}
async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  if (options.method && options.method !== 'GET') headers['X-WA-CSRF'] = state.token;
  let response;
  try {
    response = await fetch(apiUrl(url), {
      ...options,
      headers,
      cache: 'no-store',
    });
  } catch {
    throw new Error('O serviço WA.Auto não respondeu. Aguarde alguns segundos e tente novamente.');
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
  void perform(null, loadContacts);
}
function setImport(imported, draft = {}) {
  state.imported = imported;
  $('mapping').classList.remove('hidden');
  $('upload-title').textContent = imported.filename;
  $('upload-subtitle').textContent = `${imported.sheets.length} aba(s) · clique para trocar o arquivo`;
  const first = imported.sheets.find(sheet => sheet.suggestedPhone && sheet.rowCount) || imported.sheets[0];
  options($('sheet'), imported.sheets.map(sheet => sheet.name), draft.sheet || first.name, null);
  configureSheet(draft);
  configureLegalImport();
}
function configureLegalImport() {
  if (!state.imported || !$('legal-import-sheet')) return;
  $('legal-import-file').textContent = state.imported.filename;
  const sheets = state.imported.sheets.filter(sheet => sheet.rowCount);
  options($('legal-import-sheet'), sheets.map(sheet => sheet.name), $('sheet')?.value || sheets[0]?.name || '', null);
  const sheet = state.imported.sheets.find(item => item.name === $('legal-import-sheet').value) || sheets[0];
  if (!sheet) return;
  const guess = patterns => sheet.headers.find(header => patterns.some(pattern => pattern.test(header))) || '';
  options($('legal-process-column'), sheet.headers, guess([/process/i,/cnj/i,/n[uú]mero.*process/i]), 'Selecione');
  options($('legal-phone-column'), sheet.headers, guess([/telefone/i,/celular/i,/whats/i,/fone/i]), 'Selecione');
  options($('legal-name-column'), sheet.headers, guess([/cliente/i,/nome/i,/parte/i]), 'Não usar');
  options($('legal-consent-column'), sheet.headers, guess([/autoriz/i,/consent/i,/opt.?in/i,/whats.*ok/i]), 'Não usar');
  $('legal-import-button').disabled = !$('legal-process-column').value || !$('legal-phone-column').value;
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
async function loadContacts() {
  if (!state.imported || !$('phone-column').value) {
    state.contacts = null;
    $('import-contacts').classList.add('hidden');
    refreshControls();
    return;
  }
  const seq = ++state.contactLoadSeq;
  const params = new URLSearchParams({
    sheet: $('sheet').value,
    phoneColumn: $('phone-column').value,
    nameColumn: $('name-column').value,
    country: $('country').value || '55',
  });
  const result = await api(`/api/imports/${state.imported.id}/contacts?${params}`);
  if (seq !== state.contactLoadSeq) return;
  state.contacts = result;
  state.contactPage = 0;
  state.contactSelection = new Set(result.entries.filter(row => row.status === 'valid').map(row => row.row));
  renderImportedContacts();
}

function filteredContacts() {
  if (!state.contacts) return [];
  const query = state.searchQuery.trim().toLowerCase();
  return state.contacts.entries.filter(row => {
    if (state.contactFilter === 'valid' && row.status !== 'valid') return false;
    if (state.contactFilter === 'issues' && row.status === 'valid') return false;
    if (!query) return true;
    return [row.name, row.phone, row.rawPhone, row.status, row.reason].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderImportedContacts() {
  if (!state.contacts) {
    $('import-contacts').classList.add('hidden');
    $('stat-valid').textContent = '0';
    $('stat-duplicates').textContent = '0';
    $('stat-problems').textContent = '0';
    return;
  }
  const { entries, counts } = state.contacts;
  if (!state.contactSelection.size) state.contactSelection = new Set(entries.filter(row => row.status === 'valid').map(row => row.row));
  $('import-contacts').classList.remove('hidden');
  $('import-contact-summary').textContent = `${number(counts.valid)} contato(s) válido(s) para envio`;
  $('import-contact-details').textContent = `${number(counts.total)} linhas · ${number(counts.filled)} telefone(s) preenchido(s) · ${number(counts.duplicate || 0)} repetido(s) · ${number(counts.skipped || 0)} não contatar · ${number(counts.invalid || 0)} vazio(s)/inválido(s)`;
  $('send-all-valid').innerHTML = `<span>✈</span> Enviar para todos os ${number(counts.valid)} válidos <span>⌄</span>`;
  $('stat-valid').textContent = number(counts.valid);
  $('stat-duplicates').textContent = number(counts.duplicate || 0);
  $('stat-problems').textContent = number((counts.invalid || 0) + (counts.skipped || 0));
  $('contact-count-all').textContent = `(${number(counts.total)})`;
  $('contact-count-valid').textContent = `(${number(counts.valid)})`;
  $('contact-count-issues').textContent = `(${number((counts.invalid || 0) + (counts.skipped || 0) + (counts.duplicate || 0))})`;
  $('plan-usage').textContent = `${number(counts.valid)} de 5.000 contatos`;
  $('plan-progress-fill').style.width = `${Math.min(100, Math.round((counts.valid / 5000) * 100))}%`;

  const visible = filteredContacts();
  const maxPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
  if (state.contactPage > maxPage) state.contactPage = maxPage;
  const offset = state.contactPage * PAGE_SIZE;
  const rows = visible.slice(offset, offset + PAGE_SIZE);
  $('import-contact-rows').innerHTML = rows.map(row => `<tr>
    <td class="check-col"><input type="checkbox" data-contact-select="${row.row}" ${state.contactSelection.has(row.row) ? 'checked' : ''} ${row.status === 'valid' ? '' : 'disabled'}></td>
    <td><strong>${escape(row.name)}</strong></td>
    <td>${escape(row.phone ? `+${row.phone}` : row.rawPhone || '—')}</td>
    <td>${badge(row.status)}${row.reason ? `<div class="row-reason">${escape(row.reason)}</div>` : ''}</td>
    <td><button class="contact-more" data-contact-more="${row.row}" aria-label="Detalhes">•••</button></td>
  </tr>`).join('');
  for (const checkbox of $('import-contact-rows').querySelectorAll('[data-contact-select]')) checkbox.addEventListener('change', () => {
    const row = Number(checkbox.dataset.contactSelect);
    if (checkbox.checked) state.contactSelection.add(row); else state.contactSelection.delete(row);
    renderImportedContacts();
  });
  for (const button of $('import-contact-rows').querySelectorAll('[data-contact-more]')) button.addEventListener('click', () => {
    const row = entries.find(item => item.row === Number(button.dataset.contactMore));
    toast(`${row.name} · ${row.phone ? '+' + row.phone : row.rawPhone || 'sem telefone'} · ${labels[row.status] || row.status}`);
  });
  const validVisible = visible.filter(row => row.status === 'valid');
  $('contacts-select-all').checked = validVisible.length > 0 && validVisible.every(row => state.contactSelection.has(row.row));
  $('contacts-select-all').indeterminate = validVisible.some(row => state.contactSelection.has(row.row)) && !$('contacts-select-all').checked;
  $('import-contact-page-label').textContent = `${number(visible.length ? offset + 1 : 0)}–${number(Math.min(offset + PAGE_SIZE, visible.length))} de ${number(visible.length)}`;
  $('import-contact-prev').disabled = state.contactPage === 0;
  $('import-contact-next').disabled = offset + PAGE_SIZE >= visible.length;
  refreshControls();
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
for (const id of ['consent-column', 'filter-value', 'template']) $(id).addEventListener('input', invalidate);
for (const id of ['phone-column', 'name-column', 'country']) $(id).addEventListener('input', () => {
  invalidate();
  void perform(null, loadContacts);
});
$('import-contact-prev').addEventListener('click', () => { state.contactPage = Math.max(0, state.contactPage - 1); renderImportedContacts(); });
$('import-contact-next').addEventListener('click', () => { state.contactPage++; renderImportedContacts(); });
for (const [id, filter] of [['contact-tab-all','all'],['contact-tab-valid','valid'],['contact-tab-issues','issues']]) $(id).addEventListener('click', () => {
  state.contactFilter = filter;
  state.contactPage = 0;
  for (const tab of document.querySelectorAll('.contact-tab')) tab.classList.toggle('active', tab.id === id);
  renderImportedContacts();
});
$('contacts-select-all').addEventListener('change', () => {
  for (const row of filteredContacts().filter(row => row.status === 'valid')) {
    if ($('contacts-select-all').checked) state.contactSelection.add(row.row); else state.contactSelection.delete(row.row);
  }
  renderImportedContacts();
});
$('advanced-toggle').addEventListener('click', () => {
  $('advanced-fields').classList.toggle('hidden');
  $('advanced-toggle').classList.toggle('active');
});
$('variables-toggle').addEventListener('click', () => $('variables').classList.toggle('collapsed'));
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
async function prepareAllRecipients() {
  state.preview = await api('/api/preview', { method: 'POST', body: fields() });
  const pendingRows = state.preview.entries.filter(row => row.status === 'pending').map(row => row.row);
  state.selected = new Set(state.contacts ? pendingRows.filter(row => state.contactSelection.has(row)) : pendingRows);
  state.reviewPage = 0; state.saved = false;
  $('review-panel').classList.remove('hidden');
  renderReview(); renderMessage();
  $('review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return state.preview;
}
onClick('review', prepareAllRecipients);
onClick('send-all-valid', async () => {
  if (!$('campaign-name').value.trim()) {
    const base = (state.imported?.filename || 'carteira').replace(/\.(xlsx|csv)$/i, '').replace(/[_-]+/g, ' ').trim();
    $('campaign-name').value = (`Envio — ${base}`).slice(0, 120);
    saveDraft();
  }
  if (!$('template').value.trim()) {
    $('template').focus();
    $('template').scrollIntoView({ behavior: 'smooth', block: 'center' });
    throw new Error('Escreva a mensagem antes de enviar para todos.');
  }
  if (state.connection.status !== 'ready') {
    modal('connection-dialog');
    throw new Error('Conecte o WhatsApp antes de iniciar o envio para todos.');
  }
  const preview = await prepareAllRecipients();
  const allPending = preview.entries.filter(row => row.status === 'pending').map(row => row.row);
  state.selected = new Set(allPending);
  const count = allPending.length;
  if (!count) throw new Error('Nenhum contato válido ficou disponível para envio.');
  if (!confirm(`Enviar esta mensagem para todos os ${number(count)} contatos válidos da aba ${preview.sheet}? Repetidos, inválidos e “não contatar” serão excluídos.`)) return;
  const campaign = await api('/api/campaigns', { method: 'POST', body: { ...fields(), selectedRows: [...state.selected] } });
  await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST', body: { reviewed: true } });
  state.saved = true;
  await poll();
  await openCampaign(campaign.id);
  toast(`Envio iniciado para ${number(count)} contato(s) válido(s).`);
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
  showPage('campaigns', document.querySelector('[data-page="campaigns"]'));
  $('composer-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('campaign-name').focus(), 350);
});

function renderConnection() {
  const current = state.connection;
  const ready = current.status === 'ready';
  const waiting = ['connecting', 'qr', 'pairing', 'authenticated'].includes(current.status);
  $('connection-dot').className = `status-dot${ready ? ' ready' : waiting ? ' waiting' : ''}`;
  $('connection-label').textContent = !state.online ? 'Serviço indisponível' : ready ? 'WhatsApp conectado' : waiting ? 'Conectando WhatsApp' : 'WhatsApp desconectado';
  let content;
  if (current.qr) content = `<img src="${escape(current.qr)}" alt="QR Code para conectar o seu WhatsApp">`;
  else if (current.pairingCode) content = `<div class="pairing-code-box"><span class="eyebrow">CÓDIGO DE PAREAMENTO</span><strong class="pairing-code">${escape(current.pairingCode)}</strong><p class="muted">Digite este código no WhatsApp do celular.</p></div>`;
  else if (ready) content = `<div><div class="connected-avatar">✓</div><p class="connection-account">${escape(current.account?.name)}</p><p class="connection-number">${escape(current.account?.phone ? `+${current.account.phone}` : '')}</p></div>`;
  else if (waiting) content = '<div><span class="loader"></span><p class="muted">Preparando sua conexão…</p></div>';
  else content = '<div><div class="connected-avatar">↗</div><p class="muted">Seu WhatsApp conectado ao WA.Auto na nuvem.</p></div>';
  const markup = `<div class="qr-container">${content}</div><p class="connection-message">${escape(current.message || 'Conecte seu WhatsApp para começar.')}</p>`;
  if ($('connection-content').innerHTML !== markup) $('connection-content').innerHTML = markup;
  $('connect-action').textContent = ready || waiting ? 'Desconectar' : 'Gerar QR Code';
  $('pair-action').textContent = current.status === 'pairing' ? 'Gerar outro código' : 'Gerar código de pareamento';
  const displayName = ready ? (current.account?.name || 'WhatsApp') : 'WA.Auto';
  $('account-name').textContent = displayName;
  $('account-subtitle').textContent = ready && current.account?.phone ? `+${current.account.phone}` : 'Minha conta';
  $('account-avatar').textContent = displayName.trim().slice(0,2).toUpperCase();
  refreshControls();
}
$('connection-open').addEventListener('click', () => { renderConnection(); modal('connection-dialog'); });
function showConnectionTab(tab) {
  const qr = tab === 'qr';
  $('connection-tab-qr').classList.toggle('active', qr);
  $('connection-tab-phone').classList.toggle('active', !qr);
  $('connection-qr-panel').classList.toggle('hidden', !qr);
  $('connection-phone-panel').classList.toggle('hidden', qr);
  $('connect-action').classList.toggle('hidden', !qr);
}
$('connection-tab-qr').addEventListener('click', () => showConnectionTab('qr'));
$('connection-tab-phone').addEventListener('click', () => showConnectionTab('phone'));
$('switch-to-phone').addEventListener('click', () => showConnectionTab('phone'));
$('switch-to-qr').addEventListener('click', () => showConnectionTab('qr'));
showConnectionTab('qr');
onClick('connect-action', async () => {
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
  if (!confirm('Remover a sessão salva na nuvem? Você precisará escanear outro QR Code.')) return;
  state.connection = await api('/api/whatsapp/logout', { method: 'POST' }); renderConnection();
});

function renderHistory() {
  const list = state.campaigns;
  const sum = statuses => list.reduce((count, campaign) => count + statuses.reduce((s, status) => s + (campaign.counts[status] || 0), 0), 0);
  $('stat-campaigns').textContent = number(list.length);
  const attention = sum(['pending', 'resolving', 'sending']) + list.filter(campaign => campaign.status === 'running').length;
  $('notification-dot').style.display = attention > 0 ? '' : 'none';
  const query = state.searchQuery.trim().toLowerCase();
  const filteredList = query ? list.filter(campaign => campaign.name.toLowerCase().includes(query)) : list;
  const markup = filteredList.length ? filteredList.map(campaign => {
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
  disable('send-all-valid', !state.contacts || !(state.contacts.counts.valid > 0) || !state.online);
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

function legalDate(value, compact = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return compact ? date.toLocaleDateString('pt-BR') : date.toLocaleString('pt-BR');
}
function legalStatusLabel(event) {
  return ({ waiting:'Aguardando WhatsApp', sent:'Enviado', failed:'Falhou', blocked:'Não contatar', baseline:'Linha de base' })[event.send_status] || event.send_status;
}
function renderLegal() {
  if (!$('legal-stat-monitored')) return;
  const stats = state.legal || {};
  $('legal-stat-monitored').textContent = number(stats.monitored || 0);
  $('legal-stat-alerts').textContent = number(stats.alerts || 0);
  $('legal-stat-sent').textContent = number(stats.sent || 0);
  $('legal-stat-last').textContent = stats.lastScan ? legalDate(stats.lastScan, true) : '—';
  $('legal-last-scan').textContent = stats.busy ? 'Verificando agora…' : stats.lastScan ? `Última: ${legalDate(stats.lastScan)}` : 'Ainda não verificado';
  $('legal-alert-count').textContent = stats.alerts ? number(stats.alerts) : '';

  const monitors = state.legalData.monitors || [];
  $('legal-monitor-list').innerHTML = monitors.length ? monitors.map(monitor => `
    <article class="legal-monitor-row">
      <div class="legal-monitor-main">
        <div class="legal-monitor-title"><strong>${escape(monitor.client_name)}</strong><span class="subtle-tag">${escape(monitor.mode === 'both' ? 'DataJud + DJEN' : monitor.mode === 'datajud' ? 'DataJud' : 'DJEN')}</span></div>
        <div class="legal-cnj">${escape(monitor.cnj.replace(/(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})/, '$1-$2.$3.$4.$5.$6'))}</div>
        <small>+${escape(monitor.phone)} · ${monitor.enabled ? 'monitoramento ativo' : 'pausado'} · último check: ${escape(legalDate(monitor.last_checked_at))}</small>
        ${monitor.last_event_text ? `<p><b>${escape(monitor.last_event_source || '')}</b> · ${escape(monitor.last_event_text)}</p>` : ''}
        ${monitor.error ? `<div class="legal-source-error">${escape(monitor.error)}</div>` : ''}
      </div>
      <div class="legal-monitor-actions">
        <button class="button small secondary" data-legal-scan="${monitor.id}">↻ Consultar</button>
        <button class="button small secondary" data-legal-toggle="${monitor.id}" data-enabled="${monitor.enabled ? '1' : '0'}">${monitor.enabled ? 'Pausar' : 'Ativar'}</button>
        <button class="button small danger" data-legal-delete="${monitor.id}">Remover</button>
      </div>
    </article>`).join('') : '<div class="empty-history">Nenhum processo monitorado ainda.</div>';

  const events = state.legalData.events || [];
  $('legal-event-list').innerHTML = events.length ? events.slice(0,100).map(event => `
    <div class="history-row legal-event-row">
      <span class="history-icon">${event.source === 'DJEN' ? 'D' : 'J'}</span>
      <div class="history-info"><strong>${escape(event.title)}</strong><small>${escape(event.source)} · ${escape(legalDate(event.event_at))}</small>${event.details ? `<p>${escape(event.details.slice(0,420))}</p>` : ''}</div>
      <span class="badge ${escape(event.send_status)}">${escape(legalStatusLabel(event))}</span>
    </div>`).join('') : '<div class="empty-history">As novas movimentações aparecerão aqui depois da linha de base inicial.</div>';

  const errors = monitors.filter(item => item.error).length;
  $('legal-source-health').textContent = errors ? `${errors} monitor(es) com fonte parcial` : monitors.length ? 'Fontes sem erro no último check' : 'Fontes aguardando';

  for (const button of $('legal-monitor-list').querySelectorAll('[data-legal-scan]')) button.addEventListener('click', () => void perform(button, async () => {
    await api(`/api/legal/monitors/${button.dataset.legalScan}/scan`, { method:'POST', body:{} });
    await loadLegal();
    toast('Consulta processual concluída.');
  }));
  for (const button of $('legal-monitor-list').querySelectorAll('[data-legal-toggle]')) button.addEventListener('click', () => void perform(button, async () => {
    await api(`/api/legal/monitors/${button.dataset.legalToggle}/toggle`, { method:'POST', body:{ enabled:button.dataset.enabled !== '1' } });
    await loadLegal();
  }));
  for (const button of $('legal-monitor-list').querySelectorAll('[data-legal-delete]')) button.addEventListener('click', () => void perform(button, async () => {
    if (!confirm('Remover este processo do monitoramento? O histórico vinculado também será removido.')) return;
    await api(`/api/legal/monitors/${button.dataset.legalDelete}`, { method:'DELETE' });
    await loadLegal();
    toast('Processo removido do monitoramento.');
  }));
}
async function loadLegal() {
  const data = await api('/api/legal/monitors');
  state.legalData = data;
  state.legal = data.stats || state.legal;
  renderLegal();
}

$('legal-monitor-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform($('legal-add'), async () => {
    const result = await api('/api/legal/monitors', { method:'POST', body:{
      cnj:$('legal-cnj').value,
      clientName:$('legal-client').value,
      phone:$('legal-phone').value,
      mode:$('legal-mode').value,
      notifyWhatsapp:$('legal-notify').checked
    }});
    $('legal-cnj').value = '';
    $('legal-client').value = '';
    $('legal-phone').value = '';
    await loadLegal();
    toast(result.scan?.newEvents ? 'Processo monitorado e novas movimentações registradas.' : 'Processo monitorado. A linha de base foi criada sem enviar histórico antigo.');
  });
});
onClick('legal-refresh', async () => {
  const result = await api('/api/legal/scan', { method:'POST', body:{} });
  await loadLegal();
  toast(`Varredura concluída: ${number(result.checked)} processo(s), ${number(result.newEvents)} nova(s) movimentação(ões), ${number(result.sent)} aviso(s) enviado(s).`);
});
$('legal-import-sheet').addEventListener('change', configureLegalImport);
for (const id of ['legal-process-column','legal-phone-column','legal-name-column','legal-consent-column']) $(id).addEventListener('change', () => {
  $('legal-import-button').disabled = !$('legal-process-column').value || !$('legal-phone-column').value;
});
onClick('legal-import-button', async () => {
  if (!state.imported) throw new Error('Importe uma planilha primeiro.');
  const result = await api('/api/legal/monitors/import', { method:'POST', body:{
    importId:state.imported.id,
    sheet:$('legal-import-sheet').value,
    processColumn:$('legal-process-column').value,
    phoneColumn:$('legal-phone-column').value,
    nameColumn:$('legal-name-column').value,
    consentColumn:$('legal-consent-column').value,
    mode:$('legal-import-mode').value,
    notifyWhatsapp:true
  }});
  await loadLegal();
  toast(`${number(result.created)} processo(s) importado(s) · ${number(result.invalid)} inválido(s) · ${number(result.blocked)} bloqueado(s) · ${number(result.withoutConsent || 0)} sem autorização.`);
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
function showPage(page, activeButton = null) {
  for (const section of document.querySelectorAll('main>.page')) section.classList.toggle('hidden', section.id !== `page-${page}`);
  for (const nav of document.querySelectorAll('.sidebar-nav .nav-item')) nav.classList.toggle('active', nav === activeButton);
  if (page === 'blocked') void perform(null, renderBlocked);
  if (page === 'processes') void perform(null, loadLegal);
}
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page, button.closest('.sidebar-nav') ? button : null));
$('nav-whatsapp').addEventListener('click', () => { renderConnection(); modal('connection-dialog'); });
$('nav-clients').addEventListener('click', () => { showPage('campaigns', $('nav-clients')); $('clients-section').scrollIntoView({ behavior:'smooth', block:'start' }); });
$('nav-history').addEventListener('click', () => { showPage('campaigns', $('nav-history')); $('history-section').scrollIntoView({ behavior:'smooth', block:'start' }); });
$('top-help').addEventListener('click', () => showPage('help'));
$('account-button').addEventListener('click', () => showPage('blocked'));
$('plan-button').addEventListener('click', () => { showPage('help'); toast('WA.Auto Cloud é gratuito. Os limites exibidos servem apenas para organizar o uso.'); });
$('notifications-button').addEventListener('click', () => {
  const active = state.campaigns.filter(campaign => ['running','paused','draft'].includes(campaign.status));
  if (!active.length) toast('Nenhuma campanha precisa de atenção agora.');
  else { showPage('campaigns', $('nav-history')); $('history-section').scrollIntoView({ behavior:'smooth', block:'start' }); toast(`${active.length} campanha(s) no histórico para acompanhar.`); }
});
$('global-search').addEventListener('input', event => {
  state.searchQuery = event.target.value;
  state.contactPage = 0;
  renderImportedContacts();
  renderHistory();
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('global-search').focus(); }
});

let polling = false;
let pollTimer = null;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await api('/api/state');
    state.online = true;
    state.connection = response.connection;
    state.campaigns = response.campaigns;
    state.legal = response.legal || state.legal;
    $('global-error').classList.add('hidden');
    renderConnection();
    renderHistory();
    renderLegal();
    if (!$('page-processes').classList.contains('hidden')) await loadLegal();
    if ($('campaign-dialog').open && state.activeId) {
      const id = state.activeId;
      const detail = await api(`/api/campaigns/${id}`);
      if (id === state.activeId) {
        state.detail = detail;
        renderDetail();
      }
    }
  } catch (error) {
    state.online = false;
    $('global-error').textContent = error.message;
    $('global-error').classList.remove('hidden');
    renderConnection();
  } finally {
    polling = false;
  }
}

async function init() {
  const draft = getDraft();
  $('campaign-name').value = draft.name || '';
  $('template').value = draft.template || '';
  $('interval').value = draft.intervalSeconds || 30;
  $('country').value = draft.country || '55';
  renderMessage();

  const response = await api('/api/bootstrap');
  state.token = response.csrfToken;
  state.connection = response.connection;
  state.campaigns = response.campaigns;
  state.legal = response.legal || state.legal;
  renderConnection();
  renderHistory();
  renderLegal();

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
