import test from 'node:test';import assert from 'node:assert/strict';import {authorizeProjectW1SC} from '../src/crm-authorization.js';
const user='550e8400-e29b-41d4-a716-446655440000';
const req={headers:{authorization:'Bearer valid-client-token','x-wa-crm-publishable-key':'sb_publishable_for_tests','x-lexis-user-id':'ffffffff-ffff-ffff-ffff-ffffffffffff'}};
test('no JWT or publishable key cannot access the WhatsApp operator session',async()=>{
 const probe=async()=>{throw Error('must not call network')};
 assert.equal(await authorizeProjectW1SC({headers:{}},{requestFetch:probe}),null);
});
test('JWT must be verified by Supabase Auth and access RPC, not just decoded',async()=>{
 const bad=await authorizeProjectW1SC(req,{requestFetch:async()=>({ok:false})});
 assert.equal(bad,null);
 const denied=await authorizeProjectW1SC(req,{requestFetch:async(url)=>({ok:true,json:async()=>url.includes('/auth/')?{id:user}:false})});
 assert.equal(denied,null);
});
test('verified identity is taken from Auth user and ignores spoofed x-lexis-user-id',async()=>{
 const visited=[];
 const accepted=await authorizeProjectW1SC(req,{requestFetch:async(url,init)=>{
  visited.push(url);
  assert.ok(init.headers.Authorization.startsWith('Bearer '));
  return {ok:true,json:async()=>url.includes('/auth/')?{id:user}:true};
 }});
 assert.equal(accepted.userId,user);
 assert.notEqual(accepted.userId,req.headers['x-lexis-user-id']);
 assert.equal(visited.length,2);
});
