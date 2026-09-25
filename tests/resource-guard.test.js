import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceGuard } from '../src/resource-guard.js';

const bytes = mb => mb * 1024 * 1024;

test('ResourceGuard pausa com memória alta e só libera após cair abaixo do limiar de retorno', () => {
  let rss = 250;
  const guard = new ResourceGuard({
    limitMb:512,
    pauseMb:430,
    resumeMb:360,
    sample:() => ({ rss:bytes(rss), heapUsed:bytes(120), heapTotal:bytes(180), external:bytes(10) })
  });
  assert.equal(guard.snapshot().blocked,false);
  rss = 440;
  assert.equal(guard.snapshot().blocked,true);
  rss = 400;
  assert.equal(guard.snapshot().blocked,true,'histerese evita retomar perto do limite');
  rss = 350;
  assert.equal(guard.snapshot().blocked,false);
});
