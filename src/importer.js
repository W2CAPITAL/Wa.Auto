import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { AppError, requireValue } from './errors.js';
import { fold } from './phone.js';

const MAX_ROWS = 10000;
const MAX_COLUMNS = 150;

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result);
    if (value.richText) return value.richText.map(part => part.text).join('');
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value).trim();
}

export function gridToSheet(name, grid) {
  const nonEmpty = grid.map((cells, index) => ({ cells, index })).filter(row => row.cells.some(v => cellText(v)));
  if (!nonEmpty.length) return null;
  // Prefer a header containing a telephone field, including reports with a title above it.
  const recognized = nonEmpty.slice(0, 20).find(row => row.cells.some(v => /^(telefone|telefones|celular|whatsapp|fone|phone|phone number|numero|numero de telefone)$/.test(fold(cellText(v)))));
  const header = recognized || nonEmpty[0];
  const columnCount = Math.max(header.cells.length, ...nonEmpty.slice(0, 30).map(row => row.cells.length));
  requireValue(columnCount <= MAX_COLUMNS, `A aba ${name} ultrapassa ${MAX_COLUMNS} colunas.`);
  const used = new Set();
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const base = cellText(header.cells[index]) || `Coluna ${index + 1}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base} (${suffix++})`;
    used.add(key);
    return key;
  });
  const rows = nonEmpty.filter(row => row.index > header.index).map(({ cells, index }) => ({
    id: index + 1,
    values: Object.fromEntries(headers.map((key, i) => [key, cellText(cells[i])])),
  }));
  requireValue(rows.length <= MAX_ROWS, `A aba ${name} ultrapassa ${MAX_ROWS} linhas. Divida o arquivo.`);
  const suggestedPhone = headers.find(h => /^(telefone|celular|whatsapp|fone|phone|phone number|numero|numero de telefone)$/.test(fold(h))) || '';
  const suggestedName = headers.find(h => /^(cliente|nome|name|contato|nome completo)$/.test(fold(h))) || '';
  return { name, headers, rows, headerRow: header.index + 1, suggestedPhone, suggestedName };
}

export async function parseSpreadsheet(buffer, filename) {
  const extension = path.extname(filename).toLowerCase();
  requireValue(['.xlsx', '.csv'].includes(extension), 'Selecione um arquivo .xlsx ou .csv. Para .xls, salve como .xlsx no Excel.');
  let sheets;
  try {
    if (extension === '.csv') {
      let source = buffer.toString('utf8');
      if (source.includes('\uFFFD')) source = new TextDecoder('windows-1252').decode(buffer);
      const first = source.split(/\r?\n/).find(line => line.trim()) || '';
      const delimiter = [';', ',', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
      const grid = parse(source, { bom: true, delimiter, relax_column_count: true, skip_empty_lines: false, max_record_size: 100000 });
      requireValue(grid.length <= MAX_ROWS + 25, 'CSV grande demais; divida em arquivos com até 10.000 linhas.');
      sheets = [gridToSheet('Contatos', grid)].filter(Boolean);
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      requireValue(workbook.worksheets.length <= 60, 'Use um arquivo com até 60 abas.');
      sheets = workbook.worksheets.map(sheet => {
        requireValue(sheet.rowCount <= MAX_ROWS + 25, `A aba ${sheet.name} ultrapassa o limite de linhas.`);
        requireValue(sheet.columnCount <= MAX_COLUMNS, `A aba ${sheet.name} ultrapassa o limite de colunas.`);
        const grid = [];
        sheet.eachRow({ includeEmpty: true }, row => { grid.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value)); });
        return gridToSheet(sheet.name, grid);
      }).filter(Boolean);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Não foi possível ler a planilha. Confira se não está protegida por senha e salve novamente em .xlsx ou .csv.');
  }
  requireValue(sheets.length > 0 && sheets.some(sheet => sheet.rows.length), 'A planilha não tem linhas de dados.');
  return { filename: path.basename(filename), sheets };
}
