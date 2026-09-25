import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApp } from '../src/app.js';
import { TestTransport } from './helpers.js';

test('API: upload → revisão → rascunho → início → confirmação → relatório; bloqueia requisições externas', async t => {
  const store=new Store(':memory:');const transport=new TestTransport();const queue=new Queue(store,transport,{autoTick:false});
  const server=createApp({store,transport,queue}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await queue.close();await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const boot=await (await fetch(`${base}/api/bootstrap`)).json();const headers={'X-WA-CSRF':boot.csrfToken,'Content-Type':'application/json'};
  assert.equal((await fetch(`${base}/api/whatsapp/connect`,{method:'POST'})).status,403);
  assert.equal((await fetch(`${base}/api/bootstrap`,{headers:{Origin:'https://evil.example'}})).status,403);
  const crossSitePage = await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(crossSitePage.status, 200);
  assert.match(await crossSitePage.text(), /WA\.Auto/);
  const crossSiteApi = await fetch(`${base}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSiteApi.status, 403);
  const cloudStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/bootstrap`, {
      headers: {
        Host: 'wa-auto-cloud.onrender.com',
        Origin: 'https://wa-auto-cloud.onrender.com',
        'X-Forwarded-Proto': 'https'
      }
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(cloudStatus, 200);
  assert.equal((await fetch(`${base}/api/whatsapp/pair`, { method: 'POST', headers, body: '{}' })).status, 400);
  const pair = await fetch(`${base}/api/whatsapp/pair`, { method: 'POST', headers, body: '{"phone":"11999990001"}' });
  assert.equal(pair.status, 200);
  assert.equal(transport.lastConnectOptions.phoneNumber, '5511999990001');
  const form=new FormData();form.append('file',new Blob(['Cliente;Telefone\nAna;11999990001\n']), 'clientes.csv');
  const upload=await fetch(`${base}/api/imports`,{method:'POST',headers:{'X-WA-CSRF':boot.csrfToken},body:form});assert.equal(upload.status,201);const imported=await upload.json();
  const input={importId:imported.id,sheet:'Contatos',phoneColumn:'Telefone',nameColumn:'Cliente',template:'Olá, {{Cliente}}!',name:'Atendimento',intervalSeconds:10};
  const preview=await (await fetch(`${base}/api/preview`,{method:'POST',headers,body:JSON.stringify(input)})).json();assert.equal(preview.counts.pending,1);
  const campaign=await (await fetch(`${base}/api/campaigns`,{method:'POST',headers,body:JSON.stringify(input)})).json();assert.equal(campaign.status,'draft');
  assert.equal(transport.sent.length,0);
  const start=`${base}/api/campaigns/${campaign.id}/start`;
  assert.equal((await fetch(start,{method:'POST',headers,body:'{}'})).status,400);
  assert.equal((await fetch(start,{method:'POST',headers,body:'{"reviewed":true}'})).status,200);
  await queue.tick();await queue.tick();assert.equal(transport.sent.length,1);
  const details=await (await fetch(`${base}/api/campaigns/${campaign.id}`)).json();assert.equal(details.campaign.status,'completed');assert.equal(details.entries[0].message,'Olá, Ana!');
  const csv=await (await fetch(`${base}/api/campaigns/${campaign.id}/report.csv`)).text();assert.match(csv,/Olá, Ana!/);assert.match(csv,/test-1/);
  const uncertainId=store.createCampaign('Conferência manual',{intervalSeconds:10},[
    {row:1,name:'Bia',phone:'5511999990002',rawPhone:'11999990002',values:{},message:'Olá, Bia!',status:'uncertain'}
  ]);
  store.setCampaign(uncertainId,'paused','Confira a conversa');
  const uncertainEntry=store.entries(uncertainId)[0];
  const manualUrl=`${base}/api/campaigns/${uncertainId}/entries/${uncertainEntry.id}/resolve`;
  assert.equal((await fetch(manualUrl,{method:'POST',headers,body:'{"action":"sent"}'})).status,200);
  assert.equal(store.entries(uncertainId)[0].status,'sent');assert.equal(store.campaign(uncertainId).status,'completed');
  store.updateEntry(uncertainEntry.id,{status:'uncertain',reason:'Conferir novamente'});store.setCampaign(uncertainId,'paused');
  assert.equal((await fetch(manualUrl,{method:'POST',headers,body:'{"action":"retry"}'})).status,200);
  assert.equal(store.entries(uncertainId)[0].status,'pending');
  assert.equal((await fetch(`${base}/api/anything`,{method:'POST',headers,body:'not json'})).status,400);
  const page=await fetch(base);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
