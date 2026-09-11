import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';
function worker(t,dir,mode,prior) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../fixtures/checkpoint-crash-worker.mjs',import.meta.url)),dir,mode,prior?'yes':'no'],{
    env:isolatedChildEnvironment(process.env.PROBE_RUNTIME_UNDER_TEST?{PROBE_RUNTIME_UNDER_TEST:process.env.PROBE_RUNTIME_UNDER_TEST}:{}),stdio:['ignore','pipe','pipe','ipc'],shell:false});
  let stderr='';child.stderr.on('data',v=>{stderr+=v;});child.stdout.resume();
  const closed=once(child,'close');
  const message=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`worker timeout: ${stderr}`)),10000);
    child.once('message',v=>{clearTimeout(timer);resolve(v);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',()=>{clearTimeout(timer);reject(new Error(`worker closed early: ${stderr}`));});
  });
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill();await closed;}});
  return {child,message,closed};
}
for(const prior of [false,true])for(const phase of ['before-publication','after-ack','after-sent','after-checkpoint']) {
  test(`process death at ${phase}, prior association=${prior}`,{timeout:25000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'agy-checkpoint-crash-'));
    const workers=[];
    try {
      const first=worker(t,dir,phase,prior);workers.push(first);const paused=await first.message;
      assert.deepEqual(paused,{kind:'phase',phase});
      first.child.kill();await first.closed; // exact child handle, never a global process-name kill
      const second=worker(t,dir,'resume',prior);workers.push(second);const resumed=await second.message;await second.closed;
      assert.equal(resumed.kind,'result');
      const publications=await readFile(join(dir,'published.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(()=>[]);
      assert.equal(resumed.record.conversationId,'confirmed-conversation');
      if(phase==='after-ack'){
        assert.ok(resumed.rpc.error);assert.equal(resumed.providerCalls,0);assert.equal(publications.length,1);
        assert.equal(resumed.record.status,'blocked');assert.equal(resumed.outbox[0].status,'inflight');
      }else{
        assert.equal(resumed.rpc.result?.publication.status,'sent');assert.equal(resumed.trusted,'confirmed-conversation');
        assert.equal(resumed.providerCalls,1);assert.equal(resumed.record.status,'ready');
        assert.equal(publications.length,phase==='before-publication'?1:2);
        assert.equal(publications.at(-1).content,'NEW_INDEPENDENT');
        assert.ok(publications.filter(v=>v.content==='FIRST_REPLY').length<=1,'old work was not replayed');
      }
    } finally {
      for(const w of workers) if(w.child.exitCode===null && w.child.signalCode===null) {w.child.kill();await w.closed;}
      await rm(dir,{recursive:true,force:true});
    }
  });
}
