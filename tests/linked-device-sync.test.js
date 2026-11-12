import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('bridge sync returns bounded persisted history without claiming full account history',()=>{
 const api=read('src/app.js');
 assert.match(api,/lexispredict\/sync/);
 assert.match(api,/limit:12/);
 assert.match(api,/limit:15/);
 assert.match(api,/req, res/);
 assert.doesNotMatch(api,/syncFullHistory:\s*true/);
});
test('connected device history and later decrypt updates are both observed',()=>{
 const transport=read('src/whatsapp.js');
 assert.match(transport,/messaging-history\.set/);
 assert.match(transport,/messageText\(\{message:item\.update\.message\}\)/);
 assert.match(read('src/lexis-sessions.js'),/memory\.acknowledge/);
 assert.match(read('src/server.js'),/whatsappMemory\.acknowledge/);
});
