import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from '../src/queue.js';
import { Store } from '../src/store.js';
import { fixture, TestTransport } from './helpers.js';

test('fila envia apenas após início explícito, respeita intervalo e confirmações de entrega', async () => {
  const f = fixture(); const transport = new TestTransport(); let now = 100000;
  const queue = new Queue(f.store, transport, { autoTick:false, now:()=>now }); const id = f.create();
  await queue.tick(); assert.equal(transport.sent.length, 0);
  queue.start(id); await Promise.all([queue.tick(),queue.tick(),queue.tick()]); assert.equal(transport.sent.length,1);
  await queue.tick(); assert.equal(transport.sent.length,1);
  now += 30000; await queue.tick(); assert.equal(transport.sent.length,2);
  await queue.tick(); assert.equal(f.store.campaign(id).status,'completed');
  transport.emit('ack',{id:'test-1',ack:2}); assert.equal(f.store.entries(id)[0].status,'delivered');
  transport.emit('ack',{id:'test-1',ack:3}); transport.emit('ack',{id:'test-1',ack:1}); assert.equal(f.store.entries(id)[0].status,'read');
  await queue.close(); f.store.close();
});
test('pausar durante consulta ao número impede o envio', async () => {
  const f=fixture(); const t=new TestTransport(); let finish;
  t.resolve=()=>new Promise(resolve=>{finish=resolve;});
  const q=new Queue(f.store,t,{autoTick:false});const id=f.create();q.start(id);
  const sending=q.tick();q.pause(id);finish('5511999990001@c.us');await sending;
  assert.equal(t.sent.length,0);assert.equal(f.store.entries(id)[0].status,'pending');
  await q.close();f.store.close();
});
test('cancelar durante consulta não reativa o destinatário', async () => {
  const f=fixture();const t=new TestTransport();let finish;t.resolve=()=>new Promise(resolve=>{finish=resolve;});
  const q=new Queue(f.store,t,{autoTick:false});const id=f.create();q.start(id);const sending=q.tick();q.cancel(id);finish('5511999990001@c.us');await sending;
  assert.equal(t.sent.length,0);assert.deepEqual(f.store.counts(id),{cancelled:2});
  await q.close();f.store.close();
});
test('falha depois do início do envio fica incerta e não é repetida ao continuar', async () => {
  const f=fixture();const t=new TestTransport();let now=100000;let attempts=0;
  t.send=async()=>{attempts++;throw new Error('connection lost');};
  const q=new Queue(f.store,t,{autoTick:false,now:()=>now});const id=f.create();q.start(id);await q.tick();
  assert.equal(f.store.entries(id)[0].status,'uncertain');assert.equal(f.store.campaign(id).status,'paused');
  now+=30000;q.start(id);await q.tick();assert.equal(attempts,2);assert.equal(f.store.counts(id).uncertain,2);
  assert.throws(()=>q.start(id),/não tem mensagens/);await q.close();f.store.close();
});
test('falha na consulta não marca como enviado e pode continuar após reconectar', async () => {
  const f=fixture();const t=new TestTransport();t.resolve=async()=>{throw new Error('offline');};const q=new Queue(f.store,t,{autoTick:false});const id=f.create();q.start(id);await q.tick();
  assert.equal(f.store.entries(id)[0].status,'pending');assert.equal(t.sent.length,0);assert.equal(f.store.campaign(id).status,'paused');await q.close();f.store.close();
});
test('SAIR e aliases de número evitam envio repetido ao mesmo WhatsApp', async () => {
  const f=fixture();const t=new TestTransport();let now=100000;t.resolve=async()=> 'same@c.us';const q=new Queue(f.store,t,{autoTick:false,now:()=>now});const id=f.create();q.start(id);await q.tick();now+=30000;await q.tick();
  assert.equal(t.sent.length,1);assert.equal(f.store.entries(id)[1].status,'duplicate');
  await q.tick();const id2=f.create();t.emit('optout',{identities:['5511999990001']});q.start(id2);await q.tick();assert.equal(f.store.entries(id2)[0].status,'skipped');
  await q.close();f.store.close();
});
test('desconexão pausa fila e só permite uma campanha ativa', async () => {
  const f=fixture();const t=new TestTransport();const q=new Queue(f.store,t,{autoTick:false});const a=f.create();const b=f.create();q.start(a);assert.throws(()=>q.start(b),/Já existe/);
  await t.close();assert.equal(f.store.campaign(a).status,'paused');assert.throws(()=>q.start(a),/Conecte/);await q.close();f.store.close();
});
test('reinício preserva concluídas, recupera consultas e nunca repete envio em andamento', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-auto-test-'));const filename=path.join(dir,'test.sqlite');
  const f=fixture(filename);const id=f.create();const rows=f.store.entries(id);f.store.setCampaign(id,'running');f.store.updateEntry(rows[0].id,{status:'sending'});f.store.updateEntry(rows[1].id,{status:'resolving'});f.store.setMeta('nextSendAt',999999);f.store.close();
  const recovered=new Store(filename);assert.equal(recovered.campaign(id).status,'paused');assert.equal(recovered.entries(id)[0].status,'uncertain');assert.equal(recovered.entries(id)[1].status,'pending');assert.equal(recovered.getMeta('nextSendAt'),'999999');recovered.close();fs.rmSync(dir,{recursive:true,force:true});
});
