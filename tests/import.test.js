import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { normalizePhone } from '../src/phone.js';
import { parseSpreadsheet, gridToSheet } from '../src/importer.js';
import { renderTemplate, validateTemplate } from '../src/template.js';
import { prepareCampaign, csvReport } from '../src/campaigns.js';
import { fixture } from './helpers.js';

test('telefones: DDD, prefixo de país, DDD 55, internacionais e entradas ambíguas', () => {
  for (const value of ['(11) 99999-0001', '+55 11 99999-0001', '5511999990001', 11999990001, '1.1999990001e10', '005511999990001']) assert.equal(normalizePhone(value).phone, '5511999990001');
  assert.equal(normalizePhone('(55) 99999-0001').phone, '5555999990001');
  assert.equal(normalizePhone('+1 (202) 555-0100').phone, '12025550100');
  assert.equal(normalizePhone('1198887777').phone, '551198887777');
  for (const value of ['', '123', '11999990001/21999990002', '11999990001;21999990002', 'telefone 11999990001', '001', '00000000000', '5511899990001', '55199999999']) assert.equal(normalizePhone(value).phone, null, String(value));
});
test('CSV preserva aspas, acentos, quebras de linha e cabeçalhos repetidos', async () => {
  const data = await parseSpreadsheet(Buffer.from('\uFEFFCliente;Telefone;Obs;Obs\r\n"João; Silva";11999990001;"primeira\nsegunda";fim\r\n'), 'Clientes.CSV');
  assert.equal(data.sheets[0].rows[0].values.Cliente, 'João; Silva');
  assert.equal(data.sheets[0].rows[0].values.Obs, 'primeira\nsegunda');
  assert.equal(data.sheets[0].rows[0].values['Obs (2)'], 'fim');
  assert.equal(data.sheets[0].suggestedPhone, 'Telefone');
});
test('XLSX lê múltiplas abas, título acima do cabeçalho e resultado de fórmula sem executar fórmulas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Processos');
  sheet.addRow(['Relatório']); sheet.addRow([]); sheet.addRow(['Cliente','Telefone','Data']);
  sheet.addRow([{ richText: [{ text: 'Ana' }] }, 11999990001, new Date('2026-09-25T00:00:00Z')]);
  const other = workbook.addWorksheet('Outra'); other.addRow(['nome','telefone']); other.addRow(['Bia', { formula: '1+1', result: 21999990002 }]);
  const imported = await parseSpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), 'teste.xlsx');
  assert.equal(imported.sheets.length, 2);
  assert.equal(imported.sheets[0].headerRow, 3);
  assert.equal(imported.sheets[0].rows[0].id, 4);
  assert.equal(imported.sheets[0].rows[0].values.Data, '25/09/2026');
  assert.equal(imported.sheets[1].rows[0].values.telefone, '21999990002');
});
test('templates não executam dados e não deixam variáveis silenciosamente vazias', () => {
  assert.deepEqual(renderTemplate('Oi {{ Cliente }}. {{Status}}', { Cliente:'Ana', Status:'' }), {message:'Oi Ana. ',missing:['Status']});
  assert.throws(() => validateTemplate('Olá {{inexistente}}', ['Cliente']), /Colunas/);
  assert.throws(() => validateTemplate('Olá {{Cliente}', ['Cliente']), /Feche/);
  assert.equal(renderTemplate('{{Cliente}}', { Cliente:'<script>alert(1)</script>' }).message, '<script>alert(1)</script>');
});
test('revisão exclui duplicados, vazios, não falar, falta de autorização e campos ausentes', () => {
  const f = fixture(':memory:', [['Cliente','Telefone','Autorizado','Observacoes'], ['Ana','11999990001','sim',''], ['Ana repetida','+55 11 99999-0001','sim',''], ['Bia','21999990002','sim','NÃO FALAR'], ['Caio','','sim',''], ['Dora','31999990003','não',''], ['', '41999990004','sim','']]);
  const preview = prepareCampaign(f.store, { ...f.input, consentColumn:'Autorizado' });
  assert.deepEqual(preview.counts, {pending:1,duplicate:1,skipped:2,invalid:2});
  f.store.close();
});
test('não falar bloqueia o mesmo telefone inclusive quando a anotação está fora do filtro', () => {
  const f = fixture(':memory:', [['Cliente','Telefone','Autorizado','Observacoes'], ['Ana','11999990001','sim',''], ['Ana antiga','11999990001','não','NÃO FALAR']]);
  assert.equal(prepareCampaign(f.store, {...f.input,filterColumn:'Autorizado',filterValue:'sim'}).counts.skipped, 1);
  f.store.close();
});
test('seleção explícita é respeitada e mensagens ficam congeladas na campanha', () => {
  const f = fixture();
  const id = f.create({ selectedRows:[3] });
  const entries = f.store.entries(id);
  assert.equal(entries[0].status, 'excluded'); assert.equal(entries[1].message, 'Olá, Bia!');
  assert.throws(() => f.create({selectedRows:[]}), /Nenhum destinatário/);
  f.store.close();
});
test('relatório neutraliza fórmulas de planilha e escapa mensagens', () => {
  const output = csvReport({}, [{row_num:1,name:'=HYPERLINK("a")',phone:'5511999990001',message:'Olá\n"Ana"'}]);
  assert.match(output, /'=HYPERLINK/); assert.match(output, /""Ana""/);
});
test('arquivos inválidos e excesso de colunas retornam erro legível', async () => {
  await assert.rejects(() => parseSpreadsheet(Buffer.from('não é excel'), 'arquivo.xlsx'), /Não foi possível ler/);
  await assert.rejects(() => parseSpreadsheet(Buffer.from('x'), 'arquivo.xls'), /salve como/);
  assert.throws(() => gridToSheet('Grande',[Array(151).fill('Coluna')]), /150 colunas/);
});


test('XLSX no formato LexisPredict com 2.664 processos e telefone numérico é importado inteiro', async () => {
  const headers = ['Assistente','Escritorio','Advogado','Cliente','Telefone','Protocolo','Distribuicao','Status','Observacoes','Produtos','Data_Movimentacao','Andamento','Retorno','Proximo_Retorno','Tribunal','Evento_Tipo','Novo_Andamento','Encerrado_Tribunal','Busca_Apreensao','Cumprimento','DJEN_Resumo','Situacao_Prazo','Dias_Sem_Retorno','Procedente','Improcedente','Evento_Tipo.1'];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Processos');
  sheet.addRow(headers);
  for (let i = 0; i < 2664; i++) sheet.addRow(['Assistente','Escritório','Advogado',`Cliente ${i+1}`, 11900000000 + i, `P-${i+1}`,'','ATIVO','','','','','','','','','','','','','','','', '', '', '']);
  for (let i = 0; i < 26; i++) workbook.addWorksheet(`Aba ${i+2}`).addRow([]);
  const imported = await parseSpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), 'LexisPredict_Relatorio_Carteira.xlsx');
  const processos = imported.sheets.find(s => s.name === 'Processos');
  assert.ok(processos);
  assert.equal(processos.rows.length, 2664);
  assert.equal(processos.suggestedPhone, 'Telefone');
  assert.equal(processos.suggestedName, 'Cliente');
  assert.equal(processos.rows[0].values.Telefone, '11900000000');
});
