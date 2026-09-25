// CI-only UI verification. No real WhatsApp client or external messages are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import puppeteer from 'puppeteer';
import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApp } from '../src/app.js';
import { TestTransport } from './helpers.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auto-ui-'));
const store = new Store(':memory:');
const transport = new TestTransport();
transport.ready = false;
const queue = new Queue(store, transport, { autoTick: false });
const server = createApp({ store, transport, queue }).listen(0, '127.0.0.1');
await once(server, 'listening');
fs.mkdirSync('test-results', { recursive: true });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.CI ? { args: ['--no-sandbox'] } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await page.title(), 'WA.Auto — Conversas que chegam');
  assert.equal(await page.$eval('#review', el => el.disabled), true);

  // Login alternative: phone pairing code path reaches the backend and can disconnect again.
  await page.click('#connection-open');
  await page.type('#pair-phone', '11999990001');
  await page.click('#pair-action');
  await page.waitForFunction(() => document.getElementById('connection-label').textContent.includes('conectado'));
  assert.equal(transport.lastConnectOptions.phoneNumber, '5511999990001');
  await page.click('#connect-action');
  await page.waitForFunction(() => document.getElementById('connection-label').textContent.includes('desconectado'));
  await page.click('[data-close="connection-dialog"]');

  await page.screenshot({ path: 'test-results/01-desktop.png', fullPage: true });
  const fixturePath = path.join(temp, 'clientes-exemplo.csv');
  fs.writeFileSync(fixturePath, 'Cliente;Telefone;Observacoes\nAna Exemplo;11999990001;\nBruno Exemplo;21999990002;\nAna Repetida;11999990001;\nCliente sem telefone;;\nContato bloqueado;31999990003;NÃO FALAR\n');
  await (await page.$('#file-input')).uploadFile(fixturePath);
  await page.waitForFunction(() => !document.getElementById('mapping').classList.contains('hidden'));
  assert.equal(await page.$eval('#phone-column', el => el.value), 'Telefone');
  assert.equal(await page.$eval('#name-column', el => el.value), 'Cliente');
  await page.waitForFunction(() => !document.getElementById('import-contacts').classList.contains('hidden'));
  assert.match(await page.$eval('#import-contact-summary', el => el.textContent), /2 contato\(s\) válido\(s\)/);
  assert.match(await page.$eval('#import-contact-details', el => el.textContent), /5 linhas.*3 telefone\(s\) preenchido\(s\).*1 repetido\(s\).*1 não contatar.*1 vazio\(s\)\/inválido\(s\)/);
  assert.match(await page.$eval('#import-contact-rows', el => el.textContent), /Ana Exemplo/);
  assert.match(await page.$eval('#import-contact-rows', el => el.textContent), /Bruno Exemplo/);
  assert.match(await page.$eval('#send-all-valid', el => el.textContent), /Enviar para todos os 2 válidos/);
  await page.type('#campaign-name', 'Acompanhamento de clientes');
  await page.click('#sample-template');
  await page.click('#review');
  await page.waitForFunction(() => !document.getElementById('review-panel').classList.contains('hidden'));
  assert.match(await page.$eval('#review-summary', el => el.textContent), /2 selecionado\(s\).*3 linha\(s\) fora/);
  assert.equal(await page.$$eval('#review-rows input:checked', els => els.length), 2);
  assert.match(await page.$eval('#message-preview', el => el.textContent), /Olá, Ana Exemplo!/);
  await page.click('#save-campaign');
  await page.waitForFunction(() => document.getElementById('campaign-dialog').open);
  assert.equal(await page.$eval('#campaign-dialog-title', el => el.textContent), 'Acompanhamento de clientes');
  assert.equal(await page.$eval('#start-campaign', el => el.disabled), true);
  await page.click('#reviewed');
  assert.equal(await page.$eval('#start-campaign', el => el.disabled), true, 'Disconnected account must not start');
  await page.click('[data-close="campaign-dialog"]');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('phone-column').value === 'Telefone');
  assert.equal(await page.$eval('#campaign-name', el => el.value), 'Acompanhamento de clientes');
  assert.match(await page.$eval('#template', el => el.value), /{{Cliente}}/);
  assert.match(await page.$eval('#campaign-list', el => el.textContent), /Acompanhamento de clientes/);
  await page.click('#review');
  await page.waitForFunction(() => !document.getElementById('review-panel').classList.contains('hidden'));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/02-campanha-desktop.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Desktop horizontal overflow');
  await page.click('[data-page="blocked"]');
  await page.type('#block-phone', '21999990002');
  await page.type('#block-reason', 'Teste de preferência do cliente');
  await page.click('#block-form button');
  await page.waitForFunction(() => document.getElementById('blocked-list').textContent.includes('5521999990002'));
  assert.equal(store.isBlocked('5521999990002'), true);
  await page.click('[data-page="help"]');
  assert.match(await page.$eval('#page-help', el => el.innerText), /Uma lista vira conversa/);
  await page.click('[data-page="campaigns"]');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/03-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile horizontal overflow');
  assert.equal(transport.sent.length, 0, 'Draft and UI checks must never send a message');
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  console.log('UI verificada: importação, variáveis, seleção, rascunho, bloqueios, F5 e tamanhos desktop/mobile. Nenhum envio externo.');
} catch (error) {
  if (browser) { const pages = await browser.pages(); await pages.at(-1)?.screenshot({ path: 'test-results/falha.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await browser?.close();
  await queue.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
