import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.static('public', { etag: false, maxAge: 0 }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      ...(process.env.CI ? ['--no-sandbox'] : []),
      '--host-resolver-rules=MAP whatsappautomat.test 127.0.0.1'
    ]
  });
  const page = await browser.newPage();
  const failures = [];
  page.on('requestfailed', request => {
    if (request.url().includes('127.0.0.1:3210')) failures.push(request.url());
  });
  const port = server.address().port;
  await page.goto(`http://whatsappautomat.test:${port}`, { waitUntil: 'networkidle0' });
  await new Promise(resolve => setTimeout(resolve, 3500));

  assert.equal(await page.title(), 'WA.Auto — Conversas que chegam');
  assert.match(await page.$eval('#global-error', el => el.innerText), /motor local ainda não está conectado/i);
  assert.equal(failures.length, 0, 'Hosted mode must not poll localhost before explicit user action');

  await page.click('#connection-open');
  await page.waitForFunction(() => document.getElementById('connection-dialog').open);
  assert.equal(await page.$eval('#connect-action', el => el.textContent), 'Conectar motor');
  assert.equal(await page.$eval('#pair-action', el => el.disabled), true);

  await page.click('#connect-action');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const failedAfterClick = failures.length;
  assert.ok(failedAfterClick <= 1, 'Explicit connect must perform at most one localhost probe');
  assert.match(await page.$eval('#global-error', el => el.innerText), /não encontrei o motor/i);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(failures.length, failedAfterClick, 'Failed explicit connect must not start a retry storm');
  console.log('Hosted mode verificado: sem loop de localhost e conexão do motor somente sob ação explícita.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
