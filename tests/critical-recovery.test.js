import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';

test('diário crítico recupera campanha como incerta em vez de reenviar', () => {
  const f=fixture();
  const campaignId=f.create();
  const entry=f.store.entries(campaignId)[0];
  f.store.setCampaign(campaignId,'running');
  const recovered=f.store.recoverCriticalIntent({kind:'campaign',payload:{campaignId,entryId:entry.id}});
  assert.equal(recovered.recovered,true);
  assert.equal(f.store.entries(campaignId)[0].status,'uncertain');
  assert.equal(f.store.campaign(campaignId).status,'paused');
  f.store.close();
});

test('diário crítico recupera alertas jurídicos como incertos', () => {
  const store=new Store(':memory:');
  const monitor=store.createLegalMonitor({cnj:'00000000020268260000',clientName:'Ana',phone:'5511999990001'});
  const event=store.recordLegalEvent({
    monitorId:monitor.id,eventHash:'h1',source:'DataJud',title:'Despacho',eventAt:'2026-09-25T15:00:00.000Z',sendStatus:'waiting'
  });
  const recovered=store.recoverCriticalIntent({kind:'legal',payload:{eventIds:[event.id]}});
  assert.equal(recovered.recovered,true);
  assert.equal(store.legalEvents(monitor.id)[0].send_status,'uncertain');
  store.close();
});
