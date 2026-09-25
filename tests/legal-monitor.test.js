import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { LegalMonitorService, fetchDataJudProcess, fetchDjenProcess, formatCnj } from '../src/legal-monitor.js';
import { TestTransport } from './helpers.js';

const cnj='00000000020268260000';

function makeFetch() {
  let phase = 0;
  const fn = async url => {
    if (String(url).includes('datajud')) {
      const movimentos = phase === 0
        ? [{ nome:'Distribuição', dataHora:'2026-09-24T12:00:00.000Z' }]
        : [
            { nome:'Distribuição', dataHora:'2026-09-24T12:00:00.000Z' },
            { nome:'Conclusos para despacho', dataHora:'2026-09-25T14:45:00.000Z' }
          ];
      return new Response(JSON.stringify({ hits:{ hits:[{ _source:{ numeroProcesso:cnj, tribunal:'TJSP', movimentos } }] } }), { status:200, headers:{'content-type':'application/json'} });
    }
    if (String(url).includes('comunicaapi.pje.jus.br')) {
      const items = phase === 0 ? [] : [{
        id:99,
        numeroProcesso:cnj,
        data_disponibilizacao:'2026-09-25T15:00:00.000Z',
        tipoComunicacao:'Intimação',
        texto:'Intimação disponibilizada para ciência da parte.'
      }];
      return new Response(JSON.stringify({ items }), { status:200, headers:{'content-type':'application/json'} });
    }
    return new Response('{}',{status:404});
  };
  fn.next = () => { phase = 1; };
  return fn;
}

test('DataJud resolve processo e normaliza CNJ', async () => {
  const fetchImpl=makeFetch();
  const result=await fetchDataJudProcess(cnj,{fetchImpl,apiKey:'teste'});
  assert.equal(result.ok,true);
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].title,'Distribuição');
  assert.equal(formatCnj(cnj),'0000000-00.2026.8.26.0000');
});

test('DJEN aceita lista oficial de comunicações', async () => {
  const fetchImpl=makeFetch(); fetchImpl.next();
  const result=await fetchDjenProcess(cnj,{fetchImpl});
  assert.equal(result.ok,true);
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].source,'DJEN');
  assert.match(result.events[0].details,/Intimação disponibilizada/);
});

test('monitor cria linha de base sem disparar histórico e envia apenas novidades', async () => {
  const store=new Store(':memory:');
  const transport=new TestTransport();
  const fetchImpl=makeFetch();
  const service=new LegalMonitorService(store,transport,{fetchImpl,onMutation:()=>{},scanIntervalMs:999999,minTriggerIntervalMs:0,sendDelayMs:0});
  const monitor=store.createLegalMonitor({
    cnj,
    clientName:'Ana Cliente',
    phone:'5511999990001',
    tribunalAlias:'tjsp',
    mode:'both',
    notifyWhatsapp:true
  });

  const baseline=await service.scanOne(monitor,{seedOnly:true});
  assert.equal(baseline.newEvents,0);
  assert.equal(transport.sent.length,0);
  assert.ok(store.legalEvents(monitor.id).some(e=>e.send_status==='baseline'));

  fetchImpl.next();
  const second=await service.scanOne(store.legalMonitor(monitor.id));
  assert.equal(second.newEvents,2);
  assert.equal(transport.sent.length,1,'novidades do mesmo processo devem sair em um único aviso');
  assert.match(transport.sent[0].message,/ATUALIZAÇÃO PROCESSUAL/);
  assert.match(transport.sent[0].message,/Ana Cliente/);
  assert.equal(store.legalStats().sent,2);

  const third=await service.scanOne(store.legalMonitor(monitor.id));
  assert.equal(third.newEvents,0);
  assert.equal(transport.sent.length,1,'não deve reenviar o mesmo evento');

  service.stop();
  store.close();
});


test('planilha só coloca na fila movimentação posterior ao último retorno do cliente', async () => {
  const store=new Store(':memory:');
  const transport=new TestTransport();
  transport.ready=false;
  const service=new LegalMonitorService(store,transport,{fetchImpl:makeFetch(),onMutation:()=>{},scanIntervalMs:999999,minTriggerIntervalMs:0,sendDelayMs:0});
  const monitor=store.createLegalMonitor({
    cnj,
    clientName:'Cliente Retorno',
    phone:'5511999990001',
    tribunalAlias:'tjsp',
    mode:'datajud',
    notifyWhatsapp:true,
    lastReturnAt:'2026-09-24T23:59:59.999Z'
  });

  const newer=service.syncSpreadsheetSnapshot(monitor,{
    lastReturnAt:'24/09/2026',
    movementAt:'25/09/2026 14:45',
    movementText:'Conclusos para despacho',
    sourceSheet:'Processos',
    sourceRow:2
  });
  assert.equal(newer.queued,1);
  assert.equal(store.legalEvents(monitor.id).filter(e=>e.send_status==='waiting').length,1);

  const older=service.syncSpreadsheetSnapshot(store.legalMonitor(monitor.id),{
    lastReturnAt:'24/09/2026',
    movementAt:'23/09/2026 10:00',
    movementText:'Distribuição',
    sourceSheet:'Processos',
    sourceRow:2
  });
  assert.equal(older.covered,1);
  assert.equal(store.legalEvents(monitor.id).filter(e=>e.send_status==='covered_by_return').length,1);

  transport.ready=true;
  const sent=await service.sendPendingNotifications({maxGroups:1});
  assert.equal(sent.sent,1);
  assert.equal(transport.sent.length,1);
  assert.match(transport.sent[0].message,/Conclusos para despacho/);
  const updated=store.legalMonitor(monitor.id);
  assert.ok(updated.last_return_at);
  assert.ok(updated.last_notified_at);
  assert.equal(store.pendingLegalEvents(10).length,0);

  service.stop();
  store.close();
});
