import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSteeringCoordinator } from '../src/steering.js';
const windows = process.platform === 'win32';
for (const persistent of [false,true]) {
  test(`Windows steering rename handles ${persistent?'persistent':'transient'} EPERM without replay`,{skip:!windows},async(t)=>{
    const rootDir=await fs.mkdtemp(join(tmpdir(),'agy-rename-retry-'));
    t.after(()=>fs.rm(rootDir,{recursive:true,force:true}));
    const c=await createSteeringCoordinator({rootDir,ownerId:'ab'.repeat(32),channelId:'123e4567-e89b-42d3-a456-426614174000',sessionId:'rename-test',conversationId:'rename-conversation',hookConfigured:true,injectorExclusive:true});
    const before=await fs.readFile(c.paths.state,'utf8');
    const rename=fs.rename;let attempts=0;
    mock.method(fs,'rename',async(from,to)=>{
      if(to===c.paths.state && (++attempts<=2 || persistent))throw Object.assign(new Error('synthetic sharing refusal'),{code:'EPERM'});
      return rename(from,to);
    });
    syncBuiltinESMExports();
    try {
      if(persistent){await assert.rejects(c.enqueue('never committed',{claimFloorStep:0}),e=>e.cause?.code==='EPERM');assert.equal(await fs.readFile(c.paths.state,'utf8'),before);}
      else {await c.enqueue('exactly one correction',{claimFloorStep:0});assert.equal((await c.snapshot()).queue.length,1);assert.equal(attempts,3);}
    } finally {mock.restoreAll();syncBuiltinESMExports();}
  });
}
