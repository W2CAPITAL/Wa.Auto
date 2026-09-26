import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { WhatsAppMemory } from '../src/whatsapp-memory.js';

test('WhatsAppMemory: contatos, chats, busca, contexto e ultima interacao', () => {
  const store = new Store(':memory:');
  const memory = new WhatsAppMemory(store.db);
  try {
    memory.upsertContact({ jid:'5511999990001@s.whatsapp.net', name:'Ana Cliente' });
    memory.record({
      id:'m1', chatJid:'5511999990001@s.whatsapp.net', senderJid:'5511999990001@s.whatsapp.net',
      content:'Bom dia, preciso de retorno', timestamp:'2026-09-26T10:00:00.000Z'
    });
    memory.record({
      id:'m2', chatJid:'5511999990001@s.whatsapp.net', senderJid:'5511000000000@s.whatsapp.net',
      content:'Bom dia Ana, vou verificar.', isFromMe:true, timestamp:'2026-09-26T10:01:00.000Z'
    });
    memory.record({
      id:'m3', chatJid:'5511999990001@s.whatsapp.net', senderJid:'5511999990001@s.whatsapp.net',
      content:'Obrigada pelo retorno', timestamp:'2026-09-26T10:02:00.000Z'
    });

    const contacts = memory.searchContacts('Ana');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].phone, '5511999990001');

    const chats = memory.listChats({ include_last_message:true });
    assert.equal(chats.length, 1);
    assert.equal(chats[0].last_message, 'Obrigada pelo retorno');

    const found = memory.listMessages({ query:'verificar', include_context:true, context_before:1, context_after:1 });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'm2');
    assert.deepEqual(found[0].context.before.map(item=>item.id), ['m1']);
    assert.deepEqual(found[0].context.after.map(item=>item.id), ['m3']);

    assert.equal(memory.getDirectChat('5511999990001').jid, '5511999990001@s.whatsapp.net');
    assert.equal(memory.getLastInteraction('5511999990001@s.whatsapp.net').id, 'm3');

    const context = memory.getMessageContext('m2', 5, 5);
    assert.equal(context.message.id, 'm2');
    assert.deepEqual(context.before.map(item=>item.id), ['m1']);
    assert.deepEqual(context.after.map(item=>item.id), ['m3']);
    assert.deepEqual(memory.stats(), { chats:1, messages:3, lastMessageAt:'2026-09-26T10:02:00.000Z' });
  } finally {
    store.close();
  }
});

test('WhatsAppMemory: retencao remove apenas historico antigo', () => {
  const store = new Store(':memory:');
  const memory = new WhatsAppMemory(store.db);
  try {
    memory.record({
      id:'old', chatJid:'5511999990001@s.whatsapp.net', senderJid:'5511999990001@s.whatsapp.net',
      content:'antiga', timestamp:'2020-01-01T00:00:00.000Z'
    });
    memory.record({
      id:'new', chatJid:'5511999990002@s.whatsapp.net', senderJid:'5511999990002@s.whatsapp.net',
      content:'recente', timestamp:new Date().toISOString()
    });
    const pruned = memory.prune(30);
    assert.equal(pruned.messages, 1);
    assert.equal(memory.stats().messages, 1);
    assert.equal(memory.getDirectChat('5511999990001'), null);
    assert.equal(memory.getDirectChat('5511999990002').jid, '5511999990002@s.whatsapp.net');
  } finally {
    store.close();
  }
});
