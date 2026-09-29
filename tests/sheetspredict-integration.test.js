import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { LegalMonitorService } from '../src/legal-monitor.js';
import { createApp } from '../src/app.js';
import { TestTransport } from './helpers.js';

test('SheetsPredict → WA.Auto: sync em lote respeita opt-in global e último retorno', async t => {
  const store=new Store(':memory:');
  const transport=new TestTransport();
  transport.ready=false;
  const queue=new Queue(store,transport,{autoTick:false});
  const legalMonitor=new LegalMonitorService(store,transport,{
    fetchImpl:async()=>new Response('{}',{status:503}),
    onMutation:()=>{},
    scanIntervalMs:999999,
    minTriggerIntervalMs:0,
    sendDelayMs:0
  });
  const server=createApp({store,transport,queue,legalMonitor}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    legalMonitor.stop();
    await queue.close();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  });
  const base='http://127.0.0.1:'+server.address().port;
  const boot=await (await fetch(base+'/api/bootstrap')).json();
  const headers={'X-WA-CSRF':boot.csrfToken,'Content-Type':'application/json'};

  const before=await (await fetch(base+'/api/integrations/sheetspredict/status')).json();
  assert.equal(before.autoEnabled,false);

  const sync=await fetch(base+'/api/integrations/sheetspredict/sync',{
    method:'POST',headers,
    body:JSON.stringify({rows:[{
      cnj:'0000000-00.2026.8.26.0000',
      clientName:'Cliente SheetsPredict',
      phone:'11999990001',
      lastReturnAt:'24/09/2026',
      movementAt:'25/09/2026 14:45',
      movementText:'Conclusos para despacho',
      djenAt:'25/09/2026 15:00',
      djenText:'Intimação disponibilizada',
      notifyWhatsapp:true
    }]})
  });
  assert.equal(sync.status,201);
  const synced=await sync.json();
  assert.equal(synced.created,1);
  assert.equal(synced.queued,2);
  assert.equal(store.legalMonitorsBySource('sheetspredict').length,1);
  assert.equal(store.legalMonitorsBySource('sheetspredict')[0].notify_whatsapp,false);
  assert.equal(transport.sent.length,0);

  const enable=await fetch(base+'/api/integrations/sheetspredict/settings',{
    method:'POST',headers,body:JSON.stringify({autoEnabled:true})
  });
  assert.equal(enable.status,200);
  const enabled=await enable.json();
  assert.equal(enabled.autoEnabled,true);
  assert.equal(store.legalMonitorsBySource('sheetspredict')[0].notify_whatsapp,true);

  transport.ready=true;
  const delivered=await legalMonitor.sendPendingNotifications({maxGroups:1});
  assert.equal(delivered.sent,1);
  assert.equal(transport.sent.length,1);
  assert.match(transport.sent[0].message,/ATUALIZAÇÃO PROCESSUAL/);
  assert.match(transport.sent[0].message,/Conclusos para despacho/);
  assert.match(transport.sent[0].message,/Intimação disponibilizada/);

  const disable=await fetch(base+'/api/integrations/sheetspredict/settings',{
    method:'POST',headers,body:JSON.stringify({autoEnabled:false})
  });
  assert.equal(disable.status,200);
  assert.equal((await disable.json()).autoEnabled,false);
  assert.equal(store.legalMonitorsBySource('sheetspredict')[0].notify_whatsapp,false);
});
