import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { WhatsAppMemory } from '../src/whatsapp-memory.js';
import { Queue } from '../src/queue.js';
import { createApp } from '../src/app.js';
import { TestTransport } from './helpers.js';

const rpc = async (base, token, body) => fetch(base + '/mcp', {
  method:'POST',
  headers:{
    Authorization:'Bearer ' + token,
    'Content-Type':'application/json',
    Accept:'application/json, text/event-stream'
  },
  body:JSON.stringify(body)
});
const rpcPayload = async response => {
  const text = await response.text();
  if ((response.headers.get('content-type') || '').includes('text/event-stream') || /^event:/m.test(text)) {
    const values = [...text.matchAll(/^data:\s*(.+)$/gm)].map(match => match[1]);
    assert.ok(values.length > 0, 'Resposta SSE sem evento data.');
    return JSON.parse(values.at(-1));
  }
  return JSON.parse(text);
};

test('MCP: exige token e expõe ferramentas de leitura em modo seguro', async t => {
  const previousToken=process.env.WA_MCP_TOKEN;
  const previousSend=process.env.WA_MCP_ALLOW_SEND;
  const previousGroups=process.env.WA_MCP_ALLOW_GROUPS;
  const token='wa-auto-test-token-12345678901234567890';
  process.env.WA_MCP_TOKEN=token;
  process.env.WA_MCP_ALLOW_SEND='0';
  process.env.WA_MCP_ALLOW_GROUPS='0';

  const store=new Store(':memory:');
  const memory=new WhatsAppMemory(store.db);
  memory.upsertContact({jid:'5511999990001@s.whatsapp.net',name:'Ana'});
  memory.record({id:'mcp-m1',chatJid:'5511999990001@s.whatsapp.net',senderJid:'5511999990001@s.whatsapp.net',content:'Mensagem de teste'});
  const transport=new TestTransport();
  const queue=new Queue(store,transport,{autoTick:false});
  const server=createApp({store,transport,queue,whatsappMemory:memory}).listen(0,'127.0.0.1');
  await once(server,'listening');

  t.after(async()=>{
    if(previousToken==null) delete process.env.WA_MCP_TOKEN; else process.env.WA_MCP_TOKEN=previousToken;
    if(previousSend==null) delete process.env.WA_MCP_ALLOW_SEND; else process.env.WA_MCP_ALLOW_SEND=previousSend;
    if(previousGroups==null) delete process.env.WA_MCP_ALLOW_GROUPS; else process.env.WA_MCP_ALLOW_GROUPS=previousGroups;
    await queue.close();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  });

  const base='http://127.0.0.1:' + server.address().port;
  const unauthorized=await fetch(base + '/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(unauthorized.status,401);

  const initialize=await rpc(base,token,{
    jsonrpc:'2.0',id:1,method:'initialize',
    params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'wa-auto-test',version:'1.0.0'}}
  });
  assert.equal(initialize.status,200);
  const initPayload=await rpcPayload(initialize);
  assert.equal(initPayload.result?.serverInfo?.name,'wa-auto-whatsapp');

  const tools=await rpc(base,token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  assert.equal(tools.status,200);
  const toolPayload=await rpcPayload(tools);
  const names=(toolPayload.result?.tools||[]).map(item=>item.name);
  assert.ok(names.includes('search_contacts'));
  assert.ok(names.includes('list_messages'));
  assert.ok(names.includes('get_message_context'));
  assert.equal(names.includes('send_message'),false);

  const search=await rpc(base,token,{
    jsonrpc:'2.0',id:3,method:'tools/call',
    params:{name:'search_contacts',arguments:{query:'Ana'}}
  });
  assert.equal(search.status,200);
  const searchPayload=await rpcPayload(search);
  assert.equal(searchPayload.result?.structuredContent?.items?.[0]?.name,'Ana');
});
