import { requireValue } from './errors.js';

export function renderTemplate(template, values) {
  const missing = new Set();
  const message = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key) || !String(values[key] ?? '').trim()) { missing.add(key); return ''; }
    return String(values[key]);
  });
  return { message, missing: [...missing] };
}
export function validateTemplate(template, headers) {
  requireValue(typeof template === 'string' && template.trim().length > 0, 'Escreva a mensagem.');
  requireValue(template.length <= 8000, 'Use uma mensagem com até 8.000 caracteres.');
  const keys = [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
  const unknown = keys.filter(key => !headers.includes(key));
  requireValue(!unknown.length, `Colunas não encontradas na mensagem: ${[...new Set(unknown)].join(', ')}`);
  const remainder = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '');
  requireValue(!remainder.includes('{{') && !remainder.includes('}}'), 'Feche os campos no formato {{Cliente}}.');
}
