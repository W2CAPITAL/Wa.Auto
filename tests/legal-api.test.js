import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApp } from '../src/app.js';
import { LegalMonitorService } from '../src/legal-monitor.js';
import { TestTransport } from './helpers.js';

const cnj='00000000020268260000';

function fakeFetchController() {
  let phase=0;
  const fetchImpl=async url => {
    if (String(url).includes('datajud')) {
      const movimentos=phase === 0
        ? [{ nome:'Distribuição', dataHora:'2026-09-24T12:00:00.000Z' }]
        : [{ nome:'Distribuição', dataHora:'2026-09-24T12:00:00.000Z' },{ nome:'Despacho proferido', dataHora:'2026-09-25T16:00:00.000Z' }];
      return new Response(JSON.stringify({hits:{hits:[{_source:{numeroProcesso:cnj,tribunal:'TJSP',movimentos}}]}}),{status:200});
    }
    return new Response(JSON.stringify({items:[]}),{status:200});
  };
  fetchImpl.next=()=>{phase=1;};
  return fetchImpl;
}

test('API jurídica: cadastrar, criar baseline, detectar novidade, enviar e importar planilha', async t => {
  const store=new Store(':memory:');
  const transport=new TestTransport();
  const queue=new Queue(store,transport,{autoTick:false});
  const fakeFetch=fakeFetchController();
  const legalMonitor=new LegalMonitorService(store,transport,{fetchImpl:fakeFetch,onMutation:()=>{},scanIntervalMs:999999,minTriggerIntervalMs:0,sendDelayMs:0});
  const server=createApp({store,transport,queue,legalMonitor}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{ legalMonitor.stop(); await queue.close(); await new Promise(resolve=>server.close(resolve)); store.close(); });

  const base=`http://127.0.0.1:${server.address().port}`;
  const boot=await (await fetch(`${base}/api/bootstrap`)).json();
  const headers={'X-WA-CSRF':boot.csrfToken,'Content-Type':'application/json'};

  const createdResponse=await fetch(`${base}/api/legal/monitors`,{
    method:'POST',headers,
    body:JSON.stringify({cnj,clientName:'Ana Cliente',phone:'11999990001',mode:'datajud',notifyWhatsapp:true})
  });
  assert.equal(createdResponse.status,201);
  const created=await createdResponse.json();
  assert.equal(created.monitor.cnj,cnj);
  assert.equal(created.scan.newEvents,0,'primeiro scan é apenas linha de base');
  assert.equal(transport.sent.length,0);

  fakeFetch.next();
  const scan=await (await fetch(`${base}/api/legal/monitors/${created.monitor.id}/scan`,{method:'POST',headers,body:'{}'})).json();
  assert.equal(scan.newEvents,1);
  assert.equal(transport.sent.length,1);
  assert.match(transport.sent[0].message,/Despacho proferido/);

  const list=await (await fetch(`${base}/api/legal/monitors`)).json();
  assert.equal(list.monitors.length,1);
  assert.ok(list.events.some(event=>event.send_status==='sent'));

  const form=new FormData();
  form.append('file',new Blob([`Cliente;Telefone;Processo;Retorno;Proximo_Retorno;Data_Movimentacao;Andamento;Autorizado;Observacoes\nBruno;21999990002;${cnj};24/09/2026;30/09/2026;25/09/2026 10:00;Conclusos para despacho;sim;\nSem processo;11900000000;;24/09/2026;30/09/2026;25/09/2026 10:00;Movimento;sim;\nBloqueado;31999990003;00000010020268260000;24/09/2026;30/09/2026;25/09/2026 10:00;Movimento;sim;NÃO FALAR\nSem consentimento;41999990004;00000020020268260000;24/09/2026;30/09/2026;25/09/2026 10:00;Movimento;nao;\n`]),'processos.csv');
  const upload=await fetch(`${base}/api/imports`,{method:'POST',headers:{'X-WA-CSRF':boot.csrfToken},body:form});
  assert.equal(upload.status,201);
  const imported=await upload.json();

  const importedMonitors=await fetch(`${base}/api/legal/monitors/import`,{
    method:'POST',headers,
    body:JSON.stringify({importId:imported.id,sheet:'Contatos',processColumn:'Processo',phoneColumn:'Telefone',nameColumn:'Cliente',lastReturnColumn:'Retorno',nextReturnColumn:'Proximo_Retorno',movementDateColumn:'Data_Movimentacao',movementTextColumn:'Andamento',consentColumn:'Autorizado',mode:'datajud',notifyWhatsapp:true})
  });
  assert.equal(importedMonitors.status,201);
  const importedResult=await importedMonitors.json();
  assert.equal(importedResult.created,1);
  assert.equal(importedResult.invalid,1);
  assert.equal(importedResult.blocked,1);
  assert.equal(importedResult.withoutConsent,1);
  assert.equal(importedResult.queued,1);
  assert.equal(importedResult.sentNow,1);
  assert.equal(importedResult.missingReturn,0);
  assert.equal(store.legalMonitors().length,2);
  const bruno=store.legalMonitors().find(item=>item.client_name==='Bruno');
  assert.ok(bruno.last_return_at);
  assert.ok(bruno.last_notified_at);
  assert.ok(store.legalEvents(bruno.id).some(event=>event.title==='Conclusos para despacho' && event.send_status==='sent'));

  const duplicateScan=await (await fetch(`${base}/api/legal/monitors/${created.monitor.id}/scan`,{method:'POST',headers,body:'{}'})).json();
  assert.equal(duplicateScan.newEvents,0,'evento já conhecido não pode ser reenviado');
  assert.equal(transport.sent.length,2);
});
