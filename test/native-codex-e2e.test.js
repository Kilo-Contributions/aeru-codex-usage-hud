'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanCodexUsage } = require('../usage');
const { createServer } = require('../server');

const native = (ts,input,output,cached,cumulativeInput,cumulativeOutput) => ({
  timestamp: ts, type: 'event_msg',
  payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
    total_token_usage: { input_tokens: cumulativeInput, output_tokens: cumulativeOutput }
  }}
});
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gsv-native-codex-'));
  const file=path.join(root,'sessions','2026','10','16','rollout-native.jsonl');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const rows=[
    {type:'session_meta',payload:{id:'gsv-native-trace',cwd:path.join(root,'project')}},
    {type:'turn_context',payload:{model:'gpt-6'}},
    native('2026-10-16T13:00:00Z',100,20,30,100,20),
    native('2026-10-16T13:00:01Z',100,20,30,100,20), // identical cumulative snapshot: not new work
    native('2026-10-16T13:00:02Z',50,10,20,150,30),
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:150,output_tokens:30}}}}
  ];
  await fs.writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return {root,file,rows};
}
test('native real JSONL accumulates only per-execution deltas and dedups repeated snapshots',async()=>{
  const {root,file,rows}=await fixture();
  try {
    const r=await scanCodexUsage({codexDir:root});
    assert.equal(r.lifetime.totalTokens,180);
    assert.equal(r.lifetime.inputTokens,150);
    assert.equal(r.lifetime.outputTokens,30);
    assert.equal(r.lifetime.cachedInputTokens,50);
    assert.equal(r.source.usageCoverage,'observed');
    assert.deepEqual(r.source.usageEvidence,{nativeEvents:2,legacyRecords:0,mixedFiles:0});
    await fs.writeFile(file, rows.filter(x=>x.type!=='event_msg').map(x=>JSON.stringify(x)).join('\n')+'\n');
    const blank=await scanCodexUsage({codexDir:root});
    assert.equal(blank.lifetime.totalTokens,0);
    assert.equal(blank.source.usageCoverage,'unavailable');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('actual loopback HTTP returns local JSONL-derived native totals',async()=>{
  const {root}=await fixture();
  const server=createServer({codexDir:root});
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/usage');
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.lifetime.totalTokens,180);
    assert.equal(result.source.usageEvidence.nativeEvents,2);
    assert.equal(result.source.usageCoverage,'observed');
    const no=await fetch('http://127.0.0.1:'+server.address().port+'/not-found');
    assert.equal(no.status,404);
  } finally {
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  }
});
test('legacy local rollout retains prior behavior and response-id dedup',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gsv-legacy-'));
  try {
    const folder=path.join(root,'sessions');await fs.mkdir(folder);
    await fs.writeFile(path.join(folder,'one.jsonl'),[
      {type:'session_meta',payload:{session_id:'legacy'}},
      {type:'token_usage_record',timestamp:'2026-10-15T12:00:00Z',payload:{response_id:'r1',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:40}}},
      {type:'token_usage_record',timestamp:'2026-10-15T12:00:01Z',payload:{response_id:'r1',usage:{input_tokens:900,output_tokens:20}}}
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const r=await scanCodexUsage({codexDir:root});
    assert.equal(r.lifetime.totalTokens,120);
    assert.deepEqual(r.source.usageEvidence,{nativeEvents:0,legacyRecords:1,mixedFiles:0});
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('mixed legacy/native records never double-count one physical trace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsv-mixed-trace-'));
  try {
    const folder=path.join(root, 'sessions');
    await fs.mkdir(folder);
    const records = [
      { type: 'session_meta', payload: { id: 'mixed-trace' } },
      { type: 'token_usage_record', payload: { response_id:'one', usage: { input_tokens:100, output_tokens:20, cached_input_tokens:30 } } },
      native('2026-10-16T12:00:01Z',100,20,30,100,20),
      { type: 'token_usage_record', payload: { response_id:'two', usage: { input_tokens:50, output_tokens:10, cached_input_tokens:20 } } },
      native('2026-10-16T12:00:03Z',50,10,20,150,30)
    ];
    await fs.writeFile(path.join(folder,'mixed.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const data=await scanCodexUsage({codexDir:root});
    assert.equal(data.lifetime.totalTokens,180);
    assert.equal(data.lifetime.inputTokens,150);
    assert.equal(data.lifetime.outputTokens,30);
    assert.equal(data.source.usageCoverage,'partial_mixed');
    assert.deepEqual(data.source.usageEvidence,{nativeEvents:2,legacyRecords:0,mixedFiles:1});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});


test('legacy records without response_id retain historical stable turn+ordinal dedup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsv-legacy-fallback-'));
  try {
    const folder = path.join(root, 'sessions');
    await fs.mkdir(folder);
    const items = [
      { type: 'session_meta', payload: { session_id: 'trace-legacy' } },
      { type: 'token_usage_record', payload: { session_id:'trace-legacy', turn_id:'t1', usage:{input_tokens:25,output_tokens:5} } },
      { type: 'token_usage_record', payload: { session_id:'trace-legacy', turn_id:'t1', usage:{input_tokens:25,output_tokens:5} } },
      { type: 'token_usage_record', payload: { session_id:'trace-legacy', turn_id:'t2', usage:{input_tokens:30,output_tokens:10} } }
    ];
    await fs.writeFile(path.join(folder,'legacy-no-id.jsonl'), items.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const data = await scanCodexUsage({codexDir:root});
    assert.equal(data.lifetime.totalTokens,70, 'duplicate t1 record cannot double count');
    assert.equal(data.lifetime.inputTokens,55);
    assert.equal(data.lifetime.outputTokens,15);
    assert.deepEqual(data.source.usageEvidence,{nativeEvents:0,legacyRecords:2,mixedFiles:0});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
