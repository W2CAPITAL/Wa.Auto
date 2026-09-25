import { affirmative, blockedInRow, normalizePhone } from './phone.js';
import { requireValue } from './errors.js';
import { renderTemplate, validateTemplate } from './template.js';

export function prepareCampaign(store, input) {
  requireValue(typeof input.importId === 'string', 'Importe a planilha primeiro.');
  const imported = store.getImport(input.importId);
  const sheet = imported.sheets.find(item => item.name === input.sheet);
  requireValue(sheet, 'Selecione uma aba válida.');
  requireValue(sheet.headers.includes(input.phoneColumn), 'Escolha a coluna de telefone.');
  for (const key of ['nameColumn', 'consentColumn', 'filterColumn']) requireValue(!input[key] || sheet.headers.includes(input[key]), 'A coluna selecionada não existe nesta aba.');
  const country = String(input.country || '55');
  requireValue(/^[1-9]\d{0,2}$/.test(country), 'O código do país deve ter de 1 a 3 dígitos.');
  validateTemplate(input.template, sheet.headers);
  requireValue(input.selectedRows === undefined || (Array.isArray(input.selectedRows) && input.selectedRows.length <= 10000 && input.selectedRows.every(Number.isInteger)), 'Seleção de linhas inválida.');
  const selected = input.selectedRows === undefined ? null : new Set(input.selectedRows);
  const rows = sheet.rows.filter(row => !input.filterColumn || String(row.values[input.filterColumn]) === String(input.filterValue ?? ''));
  const blockedPhones = new Set(sheet.rows.filter(row => blockedInRow(row.values)).map(row => normalizePhone(row.values[input.phoneColumn], country).phone).filter(Boolean));
  const seen = new Set();
  const entries = rows.map(row => {
    const rawPhone = String(row.values[input.phoneColumn] || '');
    const { phone, error } = normalizePhone(rawPhone, country);
    const { message, missing } = renderTemplate(input.template, row.values);
    let reason = '';
    let status = 'pending';
    if (error) { status = 'invalid'; reason = error; }
    else if (blockedInRow(row.values) || blockedPhones.has(phone) || store.isBlocked(phone, `${phone}@s.whatsapp.net`, `${phone}@c.us`)) { status = 'skipped'; reason = 'Não contatar: indicação na planilha ou lista de bloqueio'; }
    else if (input.consentColumn && !affirmative(row.values[input.consentColumn])) { status = 'skipped'; reason = 'Sem autorização na coluna escolhida'; }
    else if (selected && !selected.has(row.id)) { status = 'excluded'; reason = 'Removido da seleção'; }
    else if (missing.length) { status = 'invalid'; reason = `Dados ausentes: ${missing.join(', ')}`; }
    else if (message.length > 8000) { status = 'invalid'; reason = 'Mensagem personalizada ultrapassa 8.000 caracteres'; }
    else if (seen.has(phone)) { status = 'duplicate'; reason = 'Mesmo telefone já selecionado nesta campanha'; }
    if (status === 'pending') seen.add(phone);
    return { row: row.id, name: String(row.values[input.nameColumn] || `Linha ${row.id}`), phone, rawPhone, values: row.values, message, status, reason };
  });
  const counts = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return { entries, counts, filename: imported.filename, sheet: sheet.name };
}

export function createCampaign(store, input) {
  const prepared = prepareCampaign(store, input);
  requireValue(prepared.counts.pending > 0, 'Nenhum destinatário válido selecionado. Confira a revisão.');
  const intervalSeconds = Number(input.intervalSeconds ?? 30);
  requireValue(Number.isFinite(intervalSeconds) && intervalSeconds >= 10 && intervalSeconds <= 3600, 'Use um intervalo entre 10 e 3.600 segundos.');
  requireValue(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 120, 'Dê um nome à campanha (até 120 caracteres).');
  const config = { filename: prepared.filename, sheet: prepared.sheet, template: input.template, phoneColumn: input.phoneColumn, nameColumn: input.nameColumn || '', intervalSeconds };
  return store.createCampaign(input.name.trim(), config, prepared.entries);
}

export function csvReport(campaign, entries) {
  const headers = ['Linha', 'Cliente', 'Telefone', 'Status', 'Motivo', 'Mensagem', 'ID WhatsApp', 'Atualizado'];
  // Excel must treat untrusted cell values as text, not formulas.
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = entries.map(row => [row.row_num, row.name, row.phone || row.raw_phone, row.status, row.reason, row.message, row.message_id, row.updated_at]);
  return '\uFEFF' + [headers, ...lines].map(row => row.map(cell).join(';')).join('\r\n');
}
